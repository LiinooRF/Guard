import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { PatrolRules } from '@sentrycore/shared';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { borrarEvidenciaDeDisco, type FotoVencida } from './evidencia-en-disco';
import {
  PURGA_LOTE_FOTOS,
  PURGA_LOTE_TRAZAS,
  PURGA_MAX_FOTOS_POR_TENANT,
  PURGA_MAX_TENANTS,
  PURGA_MAX_TRABADAS_POR_TENANT,
  PURGA_MAX_TRAZAS_POR_TENANT,
  PURGA_INTERVALO_MS,
  PURGA_RETENCION_JOB_NAME,
  PURGA_RETENCION_QUEUE_NAME,
  PURGA_RETENCION_SCHEDULER_ID,
} from './purga-retencion.constantes';

/**
 * Purga por retencion (#219).
 *
 * QUE BORRA Y CON QUE PLAZO
 * -------------------------
 *   patrol_tracks  ->  gpsTrackRetentionDays  (default 90 dias, piso 7)
 *   scan_photos    ->  photoRetentionDays     (default 365 dias, piso 30)
 *   event_photos   ->  ver retencionFotosDeNovedades(): hoy NUNCA
 *
 * Los dos plazos salen de las reglas del tenant resueltas en cascada, no de una
 * constante: por eso este servicio pide RulesService.effective() por empresa en
 * vez de leer tenant_rules a mano. Reimplementar la cascada aca seria repartirla
 * entre el servidor y sus clientes, que es justo lo que #80 evito.
 *
 * QUIEN BORRA
 * -----------
 * Este servicio NO borra: pide. Todo pasa por las funciones SECURITY DEFINER de
 * 1725904800219-CreateRetentionPurge, que corren como el dueño de las tablas. El
 * rol de la aplicacion sigue sin DELETE sobre scan_photos y event_photos, que es
 * lo que sostiene el caracter append-only de la evidencia. Ni siquiera este
 * codigo puede saltarselo: si alguien intentara un `DELETE FROM scan_photos`
 * desde aca, PostgreSQL responderia 42501.
 *
 * Y todas las llamadas son `SELECT ... FROM funcion(...)`, nunca un DELETE
 * suelto. Ademas de lo anterior, eso evita la trampa del driver: en TypeORM un
 * DELETE devuelve [filas, rowCount] y leerlo como arreglo cuenta 2 siempre.
 *
 * LOS DOS BUGS DE LOTE QUE ESTE ARCHIVO YA NO TIENE
 * -------------------------------------------------
 * Los dos venian de lo mismo: dar por hecho que un lote nuevo trae filas nuevas.
 *
 *   1. La pasada empezaba por `retencion_tenants`, que ordenaba por `empresa.id`
 *      y cortaba en PURGA_MAX_TENANTS. Nada achicaba el conjunto entre pasadas,
 *      asi que con 501 empresas la 501 no se purgaba NUNCA: todas las pasadas
 *      barrian las mismas 500, sin error y con el log diciendo 500 empresas.
 *      Ahora el orden es la marca de ultimo barrido, que este servicio escribe
 *      al terminar con cada empresa (`marcarBarrido`), y el techo es de trabajo
 *      por pasada y no una lista fija de privilegiadas.
 *
 *   2. `conservadas` se sumaba por lote. Y la consulta devuelve las mas viejas
 *      primero, asi que la foto cuyo archivo no se pudo borrar —que conserva su
 *      fila justamente por eso— volvia a salir primera en el lote siguiente y se
 *      contaba de nuevo: un archivo roto podia reportarse como diez. Peor aun,
 *      si los trabados llegaban a llenar un lote tapaban a TODA la evidencia
 *      vencida que venia detras. Ahora se acumulan por ID en un Set, que sirve
 *      para las dos cosas: contar cada foto una sola vez y pedirle al lote
 *      siguiente que las saltee.
 *
 * CORRE SIN CONTEXTO DE TENANT, Y NO ES UN DESCUIDO
 * -------------------------------------------------
 * El barrido cruza empresas para saber a quien le toca purgar, asi que no puede
 * setear `app.tenant_id`. Las funciones EXIGEN que no lo tenga: es el cerrojo
 * que las cierra para cualquier request. Lo que si abre transaccion CON tenant
 * es la lectura de las reglas de cada empresa, que vuelve a pasar por RLS como
 * cualquier consulta normal.
 */

/** Conjuntos de datos que la migracion sabe purgar. */
export type ConjuntoPurgable = 'patrol_tracks' | 'scan_photos' | 'event_photos';

export interface ResultadoPurga {
  readonly tenants: number;
  readonly trazas: number;
  readonly fotos: number;
  /**
   * Fotos DISTINTAS cuya fila se conservo porque su archivo no se pudo borrar.
   *
   * Distintas y no "veces que fallo un borrado": es el numero con el que el
   * operador decide si el volumen esta roto, y contar diez veces el mismo
   * archivo trabado convierte un permiso mal puesto en una alarma de disco.
   */
  readonly conservadas: number;
  /** Empresas cuya purga fallo entera. La proxima pasada las vuelve a intentar. */
  readonly fallidas: number;
}

interface FilaTenant {
  tenant_id: string;
}

interface FilaFotoVencida {
  foto_id: string;
  ruta_relativa: string;
  peso_bytes: string | number;
}

interface FilaPurgaFotos {
  filas_borradas: number;
  bytes_liberados: string | number;
}

interface FilaCorrida {
  id: string;
  dataset: ConjuntoPurgable;
  retention_days: number;
  cutoff: Date;
  rows_deleted: number;
  bytes_freed: string | number;
  executed_at: Date;
}

/**
 * Dias de retencion de las fotos del libro de novedades.
 *
 * DEVUELVE 0 = NO PURGAR NUNCA, y ese es el default a proposito. Las fotos de
 * `event_photos` respaldan el libro de novedades, que es append-only porque
 * termina en juicios laborales. Fijarle una caducidad es una decision de
 * producto con consecuencias legales, no un ajuste de disco, y no se cierra
 * desde un carril de implementacion.
 *
 * Se lee de forma defensiva —igual que `retencionDeCaidas` con
 * crashReportRetentionDays— para que el dia que el equipo agregue
 * `incidentPhotoRetentionDays` al catalogo esto empiece a funcionar solo, sin
 * tocar codigo. La ficha lista para pegar esta en INTEGRACION.md.
 */
export function retencionFotosDeNovedades(reglas: PatrolRules): number {
  const valor: unknown = (reglas as unknown as Record<string, unknown>)
    .incidentPhotoRetentionDays;
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 30 && valor <= 3650
    ? valor
    : 0;
}

@Injectable()
export class PurgaRetencionService implements OnModuleInit {
  private readonly logger = new Logger(PurgaRetencionService.name);
  private readonly evidencePath: string;

  constructor(
    @InjectQueue(PURGA_RETENCION_QUEUE_NAME)
    private readonly agenda: Queue,
    private readonly dataSource: DataSource,
    private readonly contexto: TenantContextService,
    private readonly rules: RulesService,
    config: ConfigService,
  ) {
    this.evidencePath = config.getOrThrow<string>('EVIDENCE_PATH');
  }

  /**
   * Deja programado el barrido periodico.
   *
   * `upsertJobScheduler` es idempotente: con varias replicas de la API todas
   * ejecutan este onModuleInit y queda UN solo programador. La promesa no se
   * espera, por la misma razon que el barrido de informes: esta es una de las
   * primeras llamadas a Redis del arranque, ioredis reintenta sin rendirse y
   * esperarla dejaria la API colgada si Redis esta caido. Una API que no arranca
   * es un guardia que no puede escanear; una purga que se atrasa seis horas no
   * le hace daño a nadie.
   */
  onModuleInit(): void {
    void this.agenda
      .upsertJobScheduler(
        PURGA_RETENCION_SCHEDULER_ID,
        { every: PURGA_INTERVALO_MS },
        {
          name: PURGA_RETENCION_JOB_NAME,
          // Se descarta al completarse: no lleva idempotencia por jobId (la
          // idempotencia real es que lo ya borrado no vuelve a aparecer) y
          // retenerlo solo llenaria Redis con una pasada cada seis horas.
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'purga_retencion_sin_programar',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }

  /** Una pasada del barrido: el turno de empresas que toca, los tres conjuntos. */
  async purgar(): Promise<ResultadoPurga> {
    const tenants = await this.tenants();

    let trazas = 0;
    let fotos = 0;
    let conservadas = 0;
    let fallidas = 0;

    for (const tenantId of tenants) {
      try {
        const reglas = await this.reglasDe(tenantId);

        trazas += await this.purgarTrazas(tenantId, reglas.gpsTrackRetentionDays);

        const rondas = await this.purgarFotos(
          tenantId,
          'scan_photos',
          reglas.photoRetentionDays,
        );
        fotos += rondas.borradas;
        conservadas += rondas.conservadas;

        const diasNovedades = retencionFotosDeNovedades(reglas);
        if (diasNovedades > 0) {
          const novedades = await this.purgarFotos(tenantId, 'event_photos', diasNovedades);
          fotos += novedades.borradas;
          conservadas += novedades.conservadas;
        }
      } catch (error) {
        // Una empresa que falla no puede cortar el barrido: las que vienen
        // detras son de otros clientes y su plazo legal corre igual.
        fallidas += 1;
        this.logger.warn(
          JSON.stringify({
            event: 'purga_retencion_tenant_fallo',
            tenant_id: tenantId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        // HAYA IDO BIEN O MAL. La marca es el cursor de la rotacion, no un
        // certificado de exito: una empresa que falla y no se marca se queda
        // pegada a la cabeza del orden y vuelve a tapar a las de atras, que es
        // el bug que la rotacion viene a arreglar. Su fallo ya quedo en el log.
        await this.marcarBarrido(tenantId);
      }
    }

    /*
     * SE EMITE SIEMPRE, TAMBIEN EN CERO. Es el latido del carril: sin el, una
     * purga que no corre hace una semana se ve identica a una que corre y no
     * encuentra nada vencido. Y que no corra es posible: si Redis estaba caido
     * al arrancar, el programador quedo sin registrar hasta el proximo arranque.
     *
     * Solo conteos e identificadores de empresa. Ni rutas, ni ids de ronda, ni
     * nada de una persona.
     */
    this.logger.log(
      JSON.stringify({
        event: 'purga_retencion',
        tenants: tenants.length,
        trazas,
        fotos,
        conservadas,
        fallidas,
      }),
    );

    return { tenants: tenants.length, trazas, fotos, conservadas, fallidas };
  }

  /**
   * Lo que el ADMIN ve de su propia empresa: con que plazo se esta purgando y
   * que se borro.
   *
   * A DIFERENCIA DEL BARRIDO, ESTE METODO SI CORRE CON CONTEXTO DE REQUEST: lo
   * llama el controlador, dentro de la transaccion que arma el interceptor, y
   * lee `retention_purge_runs` sujeto a RLS. Por eso no necesita —ni puede—
   * pasar por las funciones SECURITY DEFINER.
   */
  async resumenDelTenant(limite = 50) {
    const reglas = await this.rules.effective();
    const corridas = await this.contexto.manager.query<FilaCorrida[]>(
      `SELECT id, dataset, retention_days, cutoff, rows_deleted, bytes_freed, executed_at
       FROM retention_purge_runs
       ORDER BY executed_at DESC
       LIMIT $1`,
      [limite],
    );

    return {
      politica: {
        patrol_tracks: reglas.gpsTrackRetentionDays,
        scan_photos: reglas.photoRetentionDays,
        // 0 = no se purga. Ver retencionFotosDeNovedades().
        event_photos: retencionFotosDeNovedades(reglas),
      },
      corridas: corridas.map((fila) => ({
        id: fila.id,
        conjunto: fila.dataset,
        retencionDias: fila.retention_days,
        corte: fila.cutoff,
        filasBorradas: fila.rows_deleted,
        // bigint llega como string desde el driver.
        bytesLiberados: Number(fila.bytes_freed),
        ejecutadaEn: fila.executed_at,
      })),
    };
  }

  /**
   * Las empresas que le tocan a esta pasada. Solo ids, y solo desde la funcion
   * cruza-tenants.
   *
   * El orden lo pone la base: primero las que nunca se barrieron, despues las
   * que hace mas tiempo que no se atienden. Aca no hay que hacer nada mas que
   * respetarlo — y `marcarBarrido` es lo que lo hace avanzar.
   */
  private async tenants(): Promise<string[]> {
    const filas = await this.dataSource.query<FilaTenant[]>(
      `SELECT tenant_id FROM retencion_tenants($1)`,
      [PURGA_MAX_TENANTS],
    );
    return filas.map((fila) => fila.tenant_id);
  }

  /**
   * Deja escrito que a esta empresa ya le toco.
   *
   * Un fallo aca NO cuenta como empresa fallida y no se propaga: no se dejo de
   * borrar nada, lo unico que pasa es que esta empresa repite turno en la
   * proxima pasada. Convertirlo en excepcion desde un `finally` ademas taparia
   * el error real de la purga, que es el que importa.
   */
  private async marcarBarrido(tenantId: string): Promise<void> {
    try {
      await this.dataSource.query(`SELECT retencion_marcar_barrido($1)`, [tenantId]);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'purga_retencion_marca_fallida',
          tenant_id: tenantId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Reglas efectivas de una empresa, leidas CON su contexto de tenant.
   *
   * Es el mismo patron del worker de informes: aca no hay request, asi que se
   * abre transaccion propia con `set_config(..., true)` —que es SET LOCAL y
   * muere con la transaccion, en vez de quedarse pegado a la conexion del pool y
   * filtrarle el tenant al siguiente job—. Sin usuario y sin acceso de soporte:
   * el barrido no actua en nombre de nadie.
   */
  private async reglasDe(tenantId: string): Promise<PatrolRules> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.manager.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', '', true),
          set_config('app.support_access_id', '', true)`,
        [tenantId],
      );
      const reglas = await this.contexto.run(runner, () => this.rules.effective());
      // Solo se leyo configuracion: no hay nada que confirmar.
      await runner.rollbackTransaction();
      return reglas;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  /**
   * Traza de recorrido vencida, de a lotes hasta el tope de la pasada.
   *
   * Aca el lote siguiente SI trae filas nuevas siempre, porque el DELETE ya se
   * llevo las del anterior. Es la diferencia con las fotos, donde una fila puede
   * sobrevivir a su lote y volver a aparecer.
   */
  private async purgarTrazas(tenantId: string, dias: number): Promise<number> {
    let borradas = 0;
    const lotes = Math.ceil(PURGA_MAX_TRAZAS_POR_TENANT / PURGA_LOTE_TRAZAS);

    for (let lote = 0; lote < lotes; lote += 1) {
      const filas = await this.dataSource.query<Array<{ retencion_purgar_trazas: number }>>(
        `SELECT retencion_purgar_trazas($1, $2, $3)`,
        [tenantId, dias, PURGA_LOTE_TRAZAS],
      );
      const enEsteLote = Number(filas[0]?.retencion_purgar_trazas ?? 0);
      borradas += enEsteLote;
      // Un lote incompleto significa que no queda nada mas vencido.
      if (enEsteLote < PURGA_LOTE_TRAZAS) break;
    }

    return borradas;
  }

  /**
   * Evidencia fotografica vencida: primero el archivo, despues la fila.
   *
   * El corte de cada lote lo calcula la base, no este codigo: aca solo viajan los
   * dias de retencion. Un corte calculado con el reloj del proceso se equivocaria
   * con cualquier desfase entre la API y PostgreSQL, y esto borra sin vuelta.
   *
   * LAS TRABADAS SE ARRASTRAN, NO SE VUELVEN A PEDIR
   * ------------------------------------------------
   * La consulta devuelve las mas viejas primero y una foto cuyo archivo no se
   * pudo borrar CONSERVA su fila: sin excluirla, vuelve a salir la primera en
   * cada lote. Eso rompia dos cosas a la vez —el contador la sumaba una vez por
   * lote, y si las trabadas llenaban un lote tapaban a toda la evidencia vencida
   * que venia detras— asi que se juntan por ID y viajan como exclusion al lote
   * siguiente. El Set responde las dos preguntas: cuantas son de verdad y cuales
   * no hay que volver a mirar.
   */
  private async purgarFotos(
    tenantId: string,
    conjunto: Exclude<ConjuntoPurgable, 'patrol_tracks'>,
    dias: number,
  ): Promise<{ borradas: number; conservadas: number }> {
    let borradas = 0;
    const trabadas = new Set<string>();
    const motivos = new Set<string>();
    const lotes = Math.ceil(PURGA_MAX_FOTOS_POR_TENANT / PURGA_LOTE_FOTOS);

    for (let lote = 0; lote < lotes; lote += 1) {
      const vencidas = await this.dataSource.query<FilaFotoVencida[]>(
        `SELECT foto_id, ruta_relativa, peso_bytes
         FROM retencion_fotos_vencidas($1, $2, $3, $4, $5::uuid[])`,
        [tenantId, conjunto, dias, PURGA_LOTE_FOTOS, [...trabadas]],
      );
      if (vencidas.length === 0) break;

      const fotos: FotoVencida[] = vencidas.map((fila) => ({
        fotoId: fila.foto_id,
        rutaRelativa: fila.ruta_relativa,
      }));
      const disco = await borrarEvidenciaDeDisco(this.evidencePath, fotos);
      for (const fotoId of disco.conservadas) trabadas.add(fotoId);
      for (const motivo of disco.motivos) motivos.add(motivo);

      if (disco.borrables.length > 0) {
        const filas = await this.dataSource.query<FilaPurgaFotos[]>(
          `SELECT filas_borradas, bytes_liberados
           FROM retencion_purgar_fotos($1, $2, $3, $4::uuid[])`,
          [tenantId, conjunto, dias, disco.borrables],
        );
        borradas += Number(filas[0]?.filas_borradas ?? 0);
      }

      // Lote incompleto: ya no queda evidencia vencida de esta empresa.
      if (vencidas.length < PURGA_LOTE_FOTOS) break;
      // Esto ya no es un archivo con permisos raros, es el volumen roto. El log
      // de abajo avisa; insistir en esta pasada no va a borrar mas.
      if (trabadas.size >= PURGA_MAX_TRABADAS_POR_TENANT) break;
    }

    if (trabadas.size > 0) {
      // Una sola linea por empresa y conjunto, con el numero de fotos DISTINTAS
      // que quedaron. Sin rutas: el path lleva adentro el tenant y la ronda, y
      // con el codigo de error y la empresa alcanza para ir a mirar el volumen.
      this.logger.warn(
        JSON.stringify({
          event: 'purga_retencion_archivo_no_borrado',
          tenant_id: tenantId,
          conjunto,
          conservadas: trabadas.size,
          motivos: [...motivos],
        }),
      );
    }

    return { borradas, conservadas: trabadas.size };
  }
}
