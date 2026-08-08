import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';

import { RulesService } from '../rules/rules.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { rondaVencida } from './patrol-expiry';

/**
 * El barrido de rondas abandonadas.
 *
 * -------------------------------------------------------------------
 * POR QUE HACE FALTA, SI YA HAY VENCIMIENTO PEREZOSO
 * -------------------------------------------------------------------
 * El vencimiento perezoso (#258) cubre lo que ALGUIEN MIRA: la ronda se vence
 * cuando el guardia abre la app o escanea. Pero la ronda que nadie toca —el
 * guardia se fue, el telefono se quedo sin bateria, el turno no se hizo— se
 * queda `en_curso` para siempre, y con ella se queda quieto todo lo que cuelga
 * de 'vencida': las alertas de escalamiento de rondas abandonadas filtran por
 * ese estado y las estadisticas lo cuentan.
 *
 * Dicho de otra forma: sin este barrido, el sistema solo detecta al guardia que
 * vuelve. El que no vuelve —justo el caso que un sistema de vigilancia existe
 * para notar— es invisible.
 *
 * -------------------------------------------------------------------
 * DOS FILTROS, Y EL ORDEN IMPORTA
 * -------------------------------------------------------------------
 * 1. `rondas_abandonadas()` (SECURITY DEFINER, cruza empresas) devuelve
 *    CANDIDATOS con un tope grueso: 25 horas, que es mas que el maximo que la
 *    regla admite. Es una consulta barata que no sabe de cascadas.
 * 2. `rondaVencida()` decide de verdad, con las reglas EFECTIVAS del recinto de
 *    cada ronda — la misma funcion que usa el camino perezoso, para que las dos
 *    puertas no se separen nunca.
 *
 * Al reves —afinar en el SQL— se venceria una ronda que su propio recinto aun
 * considera viva, y eso le cierra el turno a un guardia que esta trabajando.
 * Este barrido puede llegar TARDE sin consecuencias; llegar de mas si las tiene.
 */

export const BARRIDO_VENCIDAS_QUEUE_NAME = 'patrol-expiry-sweep';
export const BARRIDO_VENCIDAS_JOB_NAME = 'sweep';
export const BARRIDO_VENCIDAS_SCHEDULER_ID = 'patrol-expiry-sweep';

/**
 * Cada 15 minutos. La regla mas corta que un admin puede poner son 5 minutos
 * (`maxPatrolDurationMin.min`), pero llegar tarde a vencer una ronda abandonada
 * no le cuesta nada a nadie: no hay guardia esperando del otro lado. Barrer mas
 * seguido solo agregaria consultas cruza-tenant sin comprar nada.
 */
export const BARRIDO_VENCIDAS_INTERVALO_MS = 15 * 60_000;

/** Horas tras las cuales una ronda abierta es CANDIDATA. Ver la migracion. */
const GRACIA_HORAS = 25;

export interface ResultadoBarridoVencidas {
  /** Candidatas que devolvio la base en esta pasada. */
  readonly candidatas: number;
  /** Las que las reglas de SU recinto confirmaron como vencidas. */
  readonly vencidas: number;
  /**
   * Candidatas que al mirarlas de cerca NO habia que vencer. Con la gracia del
   * SQL (25 h) por encima del maximo que la regla admite (24 h), esto es casi
   * siempre la CARRERA: el guardia cerro la ronda entre la consulta y el
   * veredicto. Va aparte de `vencidas` porque significa algo distinto —el
   * camino normal funcionando— y sumarlas convertiria el log en un rumor.
   */
  readonly aunVivas: number;
}

interface CandidataRow {
  tenant_id: string;
  patrol_id: string;
}

interface RondaRow {
  status: string;
  started_at: Date | null;
  scheduled_end_at: Date;
  site_id: string;
}

@Injectable()
export class BarridoVencidasService implements OnModuleInit {
  private readonly logger = new Logger(BarridoVencidasService.name);

  constructor(
    @InjectQueue(BARRIDO_VENCIDAS_QUEUE_NAME)
    private readonly agenda: Queue,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
  ) {}

  /**
   * Deja programado el barrido. `upsertJobScheduler` es idempotente: con varias
   * replicas de la API todas ejecutan esto y queda UN solo programador.
   *
   * No se espera la promesa, igual que en el barrido de informes: es la primera
   * llamada a Redis del arranque y si Redis esta caido ioredis reintenta sin
   * rendirse. Una API que no arranca es un guardia que no puede escanear, y lo
   * critico es el registro en terreno — este barrido es la red de seguridad.
   */
  onModuleInit(): void {
    void this.agenda
      .upsertJobScheduler(
        BARRIDO_VENCIDAS_SCHEDULER_ID,
        { every: BARRIDO_VENCIDAS_INTERVALO_MS },
        {
          name: BARRIDO_VENCIDAS_JOB_NAME,
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'barrido_vencidas_sin_programar',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }

  async barrer(): Promise<ResultadoBarridoVencidas> {
    // Sin contexto de tenant: la pregunta "en que empresa hay algo pendiente" no
    // se puede hacer desde dentro de una empresa. La funcion es SECURITY DEFINER
    // y devuelve solo identificadores.
    const candidatas = await this.dataSource.query<CandidataRow[]>(
      `SELECT tenant_id, patrol_id FROM rondas_abandonadas($1, $2)`,
      [GRACIA_HORAS, 200],
    );

    let vencidas = 0;
    let aunVivas = 0;

    for (const candidata of candidatas) {
      try {
        // Cada ronda abre SU transaccion con `app.tenant_id`: aqui adentro
        // vuelve a regir RLS, como en cualquier otra operacion del producto.
        const decidida = await this.enTenant(candidata.tenant_id, () =>
          this.vencerSiCorresponde(candidata.patrol_id),
        );
        if (decidida) vencidas += 1;
        else aunVivas += 1;
      } catch (error: unknown) {
        // Una ronda que falla no puede detener el barrido: la proxima pasada la
        // vuelve a encontrar. Se registra sin datos de personas — esto cruza
        // empresas y su fallo es de plataforma.
        this.logger.warn(
          JSON.stringify({
            event: 'barrido_vencidas_ronda_fallo',
            tenant_id: candidata.tenant_id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    this.logger.log(
      JSON.stringify({
        event: 'barrido_vencidas',
        candidatas: candidatas.length,
        vencidas,
        aun_vivas: aunVivas,
      }),
    );
    return { candidatas: candidatas.length, vencidas, aunVivas };
  }

  /**
   * Abre una transaccion con `app.tenant_id` puesto y corre ahi la operacion.
   * Copiado del worker de despacho de informes, que resuelve exactamente el
   * mismo problema: un job de fondo que cruza empresas y tiene que volver a
   * quedar bajo RLS al tocar datos.
   *
   * `set_config(..., true)` es SET LOCAL: muere con la transaccion. Con `SET` a
   * secas la variable queda pegada a la conexion del pool y la siguiente ronda
   * del barrido heredaria el tenant de la anterior — en un SaaS de empresas de
   * seguridad privada eso es una fuga cruzada, el incidente numero uno.
   *
   * Sin usuario y sin acceso de soporte: el barrido no actua en nombre de nadie.
   */
  private async enTenant<T>(tenantId: string, operacion: () => Promise<T>): Promise<T> {
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
      const resultado = await this.tenantContext.run(runner, operacion);
      await runner.commitTransaction();
      return resultado;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async vencerSiCorresponde(patrolId: string): Promise<boolean> {
    const filas = await this.tenantContext.manager.query<RondaRow[]>(
      `SELECT status, started_at, scheduled_end_at, site_id
       FROM patrols WHERE id = $1`,
      [patrolId],
    );
    const ronda = filas[0];
    if (!ronda) return false;

    // Las reglas EFECTIVAS del recinto de esta ronda, no las del tenant a secas:
    // un recinto puede tener su propia duracion maxima.
    const reglas = await this.rules.effective({ siteId: ronda.site_id });
    const vence = rondaVencida(
      {
        status: ronda.status,
        startedAt: ronda.started_at,
        scheduledEndAt: ronda.scheduled_end_at,
      },
      reglas,
      new Date(),
    );
    if (!vence) return false;

    // El WHERE repite el estado a proposito: entre el SELECT y este UPDATE el
    // guardia pudo cerrar la ronda, y pisar una 'completada' con 'vencida'
    // borraria un cierre legitimo.
    await this.tenantContext.manager.query(
      `UPDATE patrols SET status = 'vencida'
       WHERE id = $1 AND status IN ('pendiente', 'en_curso')`,
      [patrolId],
    );
    return true;
  }
}
