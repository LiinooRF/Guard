import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { PatrolRules } from '@voxia/shared';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import {
  AVISO_INICIO_CLAVE,
  AVISO_INICIO_INTERVALO_MS,
  AVISO_INICIO_JOB_NAME,
  AVISO_INICIO_MAX_ANTICIPACION_MIN,
  AVISO_INICIO_MAX_RONDAS,
  AVISO_INICIO_QUEUE_NAME,
  AVISO_INICIO_SCHEDULER_ID,
} from './aviso-inicio-ronda.constants';
import { deepLinkDeRonda } from './deep-link';
import { PushService } from './push.service';

/**
 * Aviso al guardia de que su ronda esta por comenzar (#43).
 *
 * POR QUE ES UN BARRIDO Y NO UN DISPARO
 * -------------------------------------
 * El criterio de aceptacion es que el guardia reciba el aviso CON LA APP
 * CERRADA. Con la app cerrada no hay nadie que pregunte: ni un request, ni una
 * pantalla abierta, ni el propio telefono. El unico que puede saber que faltan
 * diez minutos para las 22:00 es el servidor, mirando el reloj.
 *
 * Es la diferencia con `alertas-ronda` (#128), que comparte dominio y no comparte
 * mecanismo: aquello detecta cuando el SUPERVISOR abre su tablero, o sea despues
 * del hecho y solo si alguien esta mirando. Sirve para "esta ronda no arranco";
 * no puede servir para "esta ronda va a arrancar".
 *
 * UNA SOLA COLA PARA TODA LA PLATAFORMA, igual que el barrido de informes (#86):
 * un job por pasada, sin tenant, que se descarta al completarse. Lo que si lleva
 * contexto de tenant es cada aviso que sale de aca.
 *
 * LA ANTICIPACION LA DECIDE CADA EMPRESA
 * --------------------------------------
 * `patrolStartNoticeMin` sale de la cascada de reglas y se resuelve POR RECINTO:
 * un centro de distribucion con relevo en la porteria no quiere el mismo aviso
 * que un perimetro donde el guardia tiene que caminar quince minutos hasta el
 * primer punto. El barrido no puede leer esa regla —corre sin tenant—, asi que
 * la consulta cruza-empresas trae todo lo que empieza dentro del TECHO del
 * catalogo y el filtro fino se aplica adentro de la transaccion de cada empresa.
 *
 * NO ESCRIBE NADA. Este servicio solo lee y encola: la idempotencia ("a esta
 * ronda ya se le aviso") vive en el jobId de la cola de push, derivado del hecho
 * y del destinatario. Ver aviso-inicio-ronda.constants.ts y la migracion
 * 1725998400000-CreatePatrolStartNoticeBacklog.
 */

/** Una ronda por comenzar, tal como la devuelve la funcion cruza-empresas. */
interface CandidataRow {
  tenant_id: string;
  patrol_id: string;
}

/** Lo que hace falta para armar el aviso, ya leido bajo RLS de esa empresa. */
interface RondaRow {
  id: string;
  site_id: string;
  guard_id: string;
  scheduled_start_at: Date;
  site_name: string;
  hora_local: string;
}

export interface ResultadoAvisoInicio {
  /** Rondas por comenzar que devolvio la base en esta pasada. */
  readonly candidatas: number;
  /** Empresas distintas que tocaron esas rondas. */
  readonly empresas: number;
  /**
   * Avisos NUEVOS encolados. Va aparte de `candidatas` porque una ronda entra en
   * varias pasadas seguidas —toda la ventana de anticipacion— y solo la primera
   * encola algo: BullMQ descarta las siguientes por jobId repetido.
   */
  readonly avisadas: number;
}

/**
 * Lo que consulta cada empresa, ya con `app.tenant_id` puesto.
 *
 * SE VUELVE A COMPROBAR el estado y la hora aunque la funcion cruza-empresas ya
 * los filtro: entre las dos consultas pasan milisegundos, pero en esos
 * milisegundos el guardia pudo haber iniciado la ronda. Avisarle de que va a
 * empezar algo que ya empezo es exactamente el aviso que enseña a ignorar los
 * avisos.
 *
 * `u.is_active` es el otro criterio de aceptacion del issue —"un usuario dado de
 * baja deja de recibir push"— aplicado en el origen: al guardia desactivado no se
 * le encola nada. Es el mismo filtro que ya usa SQL_DESTINATARIOS en
 * alertas-ronda.service.ts. PushService lo vuelve a comprobar al encolar y
 * PushProcessor al entregar (los dos diffs van en INTEGRACION.md); esa segunda
 * comprobacion es la que cubre los avisos que ya estaban en la cola cuando se
 * dio de baja al usuario.
 *
 * La hora se formatea EN LA BASE, en el huso del recinto: es el unico lugar donde
 * ese huso esta a mano, y una ronda de las 22:00 avisada como "02:00" (UTC) es
 * peor que no avisar.
 */
const SQL_RONDAS = `
  SELECT
    p.id,
    p.site_id,
    p.guard_id,
    p.scheduled_start_at,
    s.name AS site_name,
    to_char(p.scheduled_start_at AT TIME ZONE s.timezone, 'HH24:MI') AS hora_local
  FROM patrols p
  JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
  JOIN users u ON u.id = p.guard_id
  WHERE p.tenant_id = app_tenant_id()
    AND p.id = ANY($1::uuid[])
    AND p.status = 'pendiente'
    AND NOT p.is_voluntary
    AND p.scheduled_start_at > now()
    AND u.is_active
  ORDER BY p.scheduled_start_at
`;

@Injectable()
export class AvisoInicioRondaService implements OnModuleInit {
  private readonly logger = new Logger(AvisoInicioRondaService.name);

  constructor(
    @InjectQueue(AVISO_INICIO_QUEUE_NAME)
    private readonly agenda: Queue,
    private readonly dataSource: DataSource,
    private readonly contexto: TenantContextService,
    private readonly rules: RulesService,
    private readonly push: PushService,
  ) {}

  /**
   * Deja programado el barrido periodico.
   *
   * `upsertJobScheduler` es idempotente a proposito: con mas de una replica de la
   * API, todas ejecutan este mismo onModuleInit y lo que queda es UN solo
   * programador, no uno por replica. Con el `queue.add({ repeat })` antiguo cada
   * arranque sumaba una entrada repetible mas y el guardia recibia el aviso
   * tantas veces como replicas hubiera.
   *
   * NO SE ESPERA LA PROMESA, y es deliberado: si Redis esta caido, ioredis
   * reintenta la conexion sin rendirse, asi que esperar aca dejaria la API
   * colgada en el arranque. Una API que no arranca es un guardia que no puede
   * escanear, y eso es peor que un recordatorio que no suena.
   */
  onModuleInit(): void {
    void this.agenda
      .upsertJobScheduler(
        AVISO_INICIO_SCHEDULER_ID,
        { every: AVISO_INICIO_INTERVALO_MS },
        {
          name: AVISO_INICIO_JOB_NAME,
          // La pasada se descarta al completarse: no lleva idempotencia por
          // jobId —esa vive en la cola de push— y retenerla solo llenaria Redis
          // con una pasada cada dos minutos, para siempre.
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'aviso_inicio_sin_programar',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }

  /**
   * Una pasada del barrido.
   *
   * Corre SIN contexto de tenant: la consulta cruza empresas para saber donde hay
   * rondas por empezar. Cada empresa se atiende despues en su propia transaccion
   * con `app.tenant_id`, y vuelve a quedar sujeta a RLS.
   */
  async barrer(): Promise<ResultadoAvisoInicio> {
    const candidatas = await this.candidatas();
    const porEmpresa = new Map<string, string[]>();
    for (const fila of candidatas) {
      porEmpresa.set(fila.tenant_id, [...(porEmpresa.get(fila.tenant_id) ?? []), fila.patrol_id]);
    }

    let avisadas = 0;
    for (const [tenantId, patrolIds] of porEmpresa) {
      // Una empresa que falla no puede cortar el barrido: las que vienen detras
      // no tienen la culpa y sus guardias tambien esperan su aviso.
      try {
        avisadas += await this.enTenant(tenantId, () => this.avisarEmpresa(patrolIds));
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'aviso_inicio_empresa_fallo',
            tenant_id: tenantId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    /*
     * SE EMITE SIEMPRE, tambien con cero: es el latido del carril. Sin el, un
     * barrido que no corre hace dos dias se ve exactamente igual que uno que
     * corre y no encuentra nada — y que no corra es posible, porque si Redis
     * esta caido al arrancar el programador queda sin registrar hasta el
     * proximo arranque (ver onModuleInit).
     *
     * Conteos y tenant_id, nada mas: ni guardias, ni recintos, ni horas.
     */
    this.logger.log(
      JSON.stringify({
        event: 'aviso_inicio_barrido',
        candidatas: candidatas.length,
        empresas: porEmpresa.size,
        avisadas,
      }),
    );

    return { candidatas: candidatas.length, empresas: porEmpresa.size, avisadas };
  }

  /**
   * Las rondas por comenzar de toda la plataforma. Pasa por la funcion
   * SECURITY DEFINER porque el barrido no tiene tenant y `patrols` esta bajo RLS
   * con FORCE: una consulta directa devolveria cero filas siempre.
   */
  private async candidatas(): Promise<CandidataRow[]> {
    return this.dataSource.query<CandidataRow[]>(
      `SELECT tenant_id, patrol_id
       FROM patrol_start_notice_backlog($1, $2)`,
      [AVISO_INICIO_MAX_ANTICIPACION_MIN, AVISO_INICIO_MAX_RONDAS],
    );
  }

  /**
   * Avisa lo que ya toca dentro de UNA empresa. Devuelve cuantos avisos nuevos
   * quedaron encolados.
   *
   * Las reglas se resuelven por recinto y se memorizan por pasada: en un cambio
   * de turno arrancan diez rondas del mismo recinto, y resolver la cascada diez
   * veces son cuatro consultas cada vez para obtener el mismo numero.
   */
  private async avisarEmpresa(patrolIds: readonly string[]): Promise<number> {
    const rondas = await this.contexto.manager.query<RondaRow[]>(SQL_RONDAS, [[...patrolIds]]);
    if (!rondas.length) return 0;

    const reglasPorRecinto = new Map<string, PatrolRules>();
    const ahora = Date.now();
    let avisadas = 0;

    for (const ronda of rondas) {
      let reglas = reglasPorRecinto.get(ronda.site_id);
      if (!reglas) {
        reglas = await this.rules.effective({ siteId: ronda.site_id });
        reglasPorRecinto.set(ronda.site_id, reglas);
      }

      const anticipacion = reglas.patrolStartNoticeMin;
      // En cero la empresa apago el aviso. No es lo mismo que "avisar al
      // instante": es no avisar.
      if (anticipacion <= 0) continue;

      const faltan = new Date(ronda.scheduled_start_at).getTime() - ahora;
      if (faltan > anticipacion * 60_000) continue;

      const { enqueued } = await this.push.send(
        [ronda.guard_id],
        {
          title: 'Tu ronda está por comenzar',
          /*
           * Recinto y hora, y nada mas. Esto se lee en una pantalla bloqueada
           * que puede estar sobre una mesa y viaja por un tercero: ni el nombre
           * del guardia, ni la ruta, ni los puntos. Lo que necesita para
           * moverse ya esta aca; el resto vive detras de la sesion.
           */
          body: `${ronda.site_name}: comienza a las ${ronda.hora_local}.`,
          deepLink: deepLinkDeRonda(ronda.id, ronda.site_id),
          /*
           * ALTA aunque no sea una emergencia, y es una decision, no un
           * descuido. `alta` es urgencia del TRANSPORTE, no criticidad del
           * negocio: es lo unico que atraviesa el ahorro de bateria de Android.
           * Un aviso que el sistema puede juntar con otro trabajo llega cuando
           * el sistema quiera, y este aviso se VENCE a una hora exacta —el
           * telefono del guardia esta en el bolsillo y la app cerrada, que es
           * justo el escenario del criterio de aceptacion—. Entregado tarde no
           * es un aviso degradado: es ruido que desinforma.
           */
          urgency: 'alta',
          // Un solo recordatorio por ronda en la bandeja. Si alguna vez se
          // agregara un segundo aviso de la misma ronda, reemplaza en vez de
          // apilarse.
          collapseKey: `inicio-ronda:${ronda.id}`,
        },
        { idempotencyKey: `${AVISO_INICIO_CLAVE}:${ronda.id}` },
      );
      avisadas += enqueued;
    }

    return avisadas;
  }

  /**
   * Abre una transaccion con contexto de tenant, igual que EnvioInformeProcessor.
   *
   * `set_config(..., true)` es SET LOCAL: muere con la transaccion y no se pega a
   * la conexion del pool. Con `SET` a secas la empresa siguiente del barrido
   * heredaria el tenant de la anterior, que en un SaaS de empresas de seguridad
   * es la fuga que no se puede permitir. Y el barrido recorre empresas una tras
   * otra sobre el mismo pool: aca esa trampa no es teorica.
   */
  private async enTenant<T>(tenantId: string, operacion: () => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // Sin usuario: el barrido no actua en nombre de nadie. Y sin acceso de
      // soporte: esa ventana se abre para que una persona mire, no para que un
      // job de fondo empuje notificaciones.
      await runner.manager.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', '', true),
          set_config('app.support_access_id', '', true)`,
        [tenantId],
      );
      const resultado = await this.contexto.run(runner, operacion);
      await runner.commitTransaction();
      return resultado;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
