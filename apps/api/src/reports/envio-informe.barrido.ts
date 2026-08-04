import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';

import {
  ENVIO_INFORME_JOB_ATTEMPTS,
  ENVIO_INFORME_JOB_BACKOFF_MS,
  ENVIO_INFORME_JOB_NAME,
  ENVIO_INFORME_QUEUE_NAME,
} from './envio-informe.constants';
import type { EnvioInformeJobData } from './envio-informe.types';

/**
 * Barrido de rondas cerradas que se quedaron sin informe (#86).
 *
 * POR QUE EXISTE
 * --------------
 * El disparo normal ocurre al marcarse el punto de cierre y encola un despacho.
 * Ese camino cubre el caso feliz, pero deja tres agujeros que no se tapan desde
 * el propio despacho (ver el comentario largo de la migracion
 * 1725472900000-CreateReportDispatchBacklog):
 *
 *   1. El `add` a Redis ocurre dentro de la transaccion del escaneo. Si el
 *      proceso muere justo despues del commit, la ronda queda cerrada y sin
 *      informe.
 *   2. El jobId del despacho se deriva del patrolId y los jobs se retienen. Si
 *      el despacho agota sus intentos, ese jobId queda ocupado y la ronda no se
 *      puede volver a encolar nunca.
 *   3. Si se limpia Redis, lo pendiente desaparece.
 *
 * En los tres casos el panel muestra la ronda cerrada y al cliente no le llego
 * nada. El criterio de aceptacion dice "cerrar la ronda deja el PDF en el correo
 * del destinatario SIN ACCION MANUAL"; sin este barrido, la reparacion de esos
 * tres casos es exactamente una accion manual.
 *
 * ES UNA RED DE SEGURIDAD, NO UN SEGUNDO CAMINO DE ENVIO
 * ------------------------------------------------------
 * Solo mira rondas que no tienen NINGUNA entrega registrada ni marca de haber
 * sido atendidas. Una ronda a la que ya se le mando el informe no vuelve a
 * entrar aca aunque despues se agregue un destinatario nuevo: agregar un correo
 * no es motivo para re-emitir informes viejos. Y una ronda que el despacho
 * atendio y decidio no mandar —envio automatico apagado, o empresa sin
 * destinatarios— tampoco vuelve a entrar, porque el despacho le dejo su fila en
 * `report_dispatch_attempts`. Sin esa marca, las rondas de una empresa con el
 * envio apagado ocuparian el cupo de cada pasada durante toda la ventana de
 * rescate y dejarian al barrido sin lugar para las que si se perdieron.
 *
 * NO ROMPE LA IDEMPOTENCIA, LA APOYA
 * ----------------------------------
 * El rescate se encola con un jobId PROPIO (prefijo `barrido:`), distinto del
 * que uso el disparo normal —si usara el mismo, chocaria justamente con el
 * jobId quemado que estamos tratando de esquivar—. Que sean dos jobs distintos
 * no duplica correos: quien garantiza el "una sola vez" es la tabla
 * `report_deliveries` con su UNIQUE, y ademas cada correo lleva su clave de
 * idempotencia. El jobId del barrido tambien es estable, asi que cada ronda
 * recibe UN rescate (con sus propios reintentos internos) y no un reintento
 * infinito cada diez minutos.
 */

export const ENVIO_BARRIDO_QUEUE_NAME = 'report-dispatch-sweep';
export const ENVIO_BARRIDO_JOB_NAME = 'sweep';
export const ENVIO_BARRIDO_SCHEDULER_ID = 'report-dispatch-sweep';

/**
 * Cada cuanto pasa el barrido, cuanta gracia le da al camino normal, hasta donde
 * mira atras y cuantas rondas rescata por pasada.
 *
 * NO VAN A rules.ts, con el mismo criterio que ENVIO_INFORME_JOB_ATTEMPTS: no
 * describen una politica que el admin de una empresa quiera cambiar, describen
 * cuanto aguanta el sistema una caida propia. Ningun jefe de operaciones pide
 * "barreme cada 7 minutos"; pide que el informe llegue. El unico que podria
 * discutirse es la ventana de rescate —hay una ficha de catalogo lista en
 * INTEGRACION.md por si el equipo decide que si es negocio—.
 *
 * La gracia (15 min) es holgada a proposito: el despacho normal reintenta cinco
 * veces con espera exponencial desde 5 s, o sea que puede tardar mas de un
 * minuto en resolverse. El barrido no debe pisarlo mientras todavia esta vivo.
 */
export const ENVIO_BARRIDO_INTERVALO_MS = 10 * 60_000;
export const ENVIO_BARRIDO_GRACIA_MIN = 15;
export const ENVIO_BARRIDO_VENTANA_H = 48;
export const ENVIO_BARRIDO_MAX_RONDAS = 200;

/** Una ronda cerrada, sin entregas y sin marca de atendida. Solo identificadores. */
export interface RondaRezagada {
  readonly tenantId: string;
  readonly patrolId: string;
}

export interface ResultadoBarrido {
  /** Rondas rezagadas que devolvio la base en esta pasada. */
  readonly rezagadas: number;
  /** Rescates NUEVOS encolados en esta pasada. */
  readonly encoladas: number;
  /**
   * Rondas que ya tenian su rescate en la cola y no se volvieron a encolar.
   *
   * Va aparte de `encoladas` porque son dos hechos distintos y el operador los
   * lee distinto: "encolé 200" dice que el camino normal esta perdiendo rondas
   * ahora; "ya estaban rescatadas" dice que el barrido ya hizo su trabajo y
   * espera. Sumarlas en un solo numero convertiria el log en un rumor.
   */
  readonly yaRescatadas: number;
}

interface RezagadaRow {
  tenant_id: string;
  patrol_id: string;
}

@Injectable()
export class BarridoEnvioService implements OnModuleInit {
  private readonly logger = new Logger(BarridoEnvioService.name);

  constructor(
    @InjectQueue(ENVIO_BARRIDO_QUEUE_NAME)
    private readonly agenda: Queue,
    @InjectQueue(ENVIO_INFORME_QUEUE_NAME)
    private readonly despachos: Queue<EnvioInformeJobData>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Deja programado el barrido periodico.
   *
   * `upsertJobScheduler` es idempotente a proposito: con mas de una replica de
   * la API, todas ejecutan este mismo onModuleInit y lo que queda es UN solo
   * programador, no uno por replica. Con el `queue.add({ repeat })` antiguo cada
   * arranque sumaba una entrada repetible mas.
   *
   * NO SE ESPERA LA PROMESA, Y ES DELIBERADO. Esta es la primera llamada a Redis
   * del arranque. Si Redis esta caido, ioredis reintenta la conexion sin
   * rendirse, asi que esperar aca dejaria el arranque de la API colgado
   * indefinidamente. Y una API que no arranca es un guardia que no puede
   * escanear: lo critico es el registro en terreno, no el barrido, que es la red
   * de seguridad. Si no se pudo programar queda el error en el log y se vuelve a
   * intentar en el proximo arranque.
   */
  onModuleInit(): void {
    void this.agenda
      .upsertJobScheduler(
        ENVIO_BARRIDO_SCHEDULER_ID,
        { every: ENVIO_BARRIDO_INTERVALO_MS },
        {
          name: ENVIO_BARRIDO_JOB_NAME,
          // El barrido si se descarta al completarse: no lleva idempotencia por
          // jobId (esa vive en el despacho y en report_deliveries) y retenerlo
          // solo llenaria Redis con una pasada cada diez minutos, para siempre.
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          JSON.stringify({
            event: 'informe_barrido_sin_programar',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }

  /**
   * Una pasada del barrido.
   *
   * Corre SIN contexto de tenant y a proposito: la consulta cruza empresas para
   * saber donde falta informe. Por eso pasa por `report_dispatch_backlog()`, que
   * es SECURITY DEFINER y devuelve solo identificadores. Cada despacho que se
   * encola desde aca abre despues su propia transaccion CON `app.tenant_id` y
   * vuelve a quedar sujeto a RLS.
   */
  async barrer(): Promise<ResultadoBarrido> {
    const rezagadas = await this.rezagadas();

    let encoladas = 0;
    let yaRescatadas = 0;
    for (const ronda of rezagadas) {
      // Una ronda que no se puede encolar no puede cortar el barrido: las que
      // vienen detras son de otras empresas y no tienen la culpa.
      try {
        if (await this.reencolar(ronda)) encoladas += 1;
        else yaRescatadas += 1;
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'informe_rezagada_sin_encolar',
            tenant_id: ronda.tenantId,
            patrol_id: ronda.patrolId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    // Conteos y nada mas. Que haya rezagadas es una señal operativa: si este
    // numero deja de ser cero seguido, algo del camino normal esta fallando.
    //
    // SE EMITE SIEMPRE, TAMBIEN CON CERO. Es el latido del carril: sin el, un
    // barrido que no corre hace dos dias se ve exactamente igual que uno que
    // corre y no encuentra nada. Y que no corra es posible: si Redis esta caido
    // al arrancar, el programador queda sin registrar hasta el proximo arranque
    // (ver onModuleInit).
    this.logger.log(
      JSON.stringify({
        event: 'informe_barrido',
        rezagadas: rezagadas.length,
        encoladas,
        ya_rescatadas: yaRescatadas,
      }),
    );

    return { rezagadas: rezagadas.length, encoladas, yaRescatadas };
  }

  /**
   * Las rondas cerradas que no tienen entrega ni marca de haber sido atendidas.
   *
   * Los dos descuentos los hace la funcion en la base
   * (`1725472900000-CreateReportDispatchBacklog`), no este codigo: es una sola
   * consulta y el barrido no puede leer datos de negocio de otros tenants.
   */
  private async rezagadas(): Promise<RondaRezagada[]> {
    const filas = await this.dataSource.query<RezagadaRow[]>(
      `SELECT tenant_id, patrol_id
       FROM report_dispatch_backlog($1, $2, $3)`,
      [ENVIO_BARRIDO_GRACIA_MIN, ENVIO_BARRIDO_VENTANA_H, ENVIO_BARRIDO_MAX_RONDAS],
    );
    return filas.map((fila) => ({ tenantId: fila.tenant_id, patrolId: fila.patrol_id }));
  }

  /**
   * Encola el rescate de una ronda. Devuelve false cuando ya lo tenia.
   *
   * El jobId lleva el prefijo `barrido:` para no chocar con el del disparo
   * normal —que puede estar quemado, que es justamente por lo que llegamos
   * aca— y se hashea con el mismo criterio que el resto de las colas: en Redis
   * no quedan identificadores de negocio legibles.
   *
   * SE PREGUNTA ANTES DE ENCOLAR, y no es de mas: BullMQ descarta en silencio un
   * `add` con un jobId ya usado y devuelve el job que ya estaba, asi que desde
   * el valor de retorno no hay forma de distinguir un rescate nuevo de un
   * no-op. Sin este `getJob`, el barrido reportaria como "encoladas" 200 rondas
   * a las que no les hizo nada.
   */
  private async reencolar(ronda: RondaRezagada): Promise<boolean> {
    const jobId = createHash('sha256')
      .update(`envio-informe:barrido:${ronda.patrolId}`)
      .digest('hex');

    if (await this.despachos.getJob(jobId)) return false;

    await this.despachos.add(
      ENVIO_INFORME_JOB_NAME,
      { tenantId: ronda.tenantId, patrolId: ronda.patrolId },
      {
        jobId,
        attempts: ENVIO_INFORME_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: ENVIO_INFORME_JOB_BACKOFF_MS },
        // Se retienen por la misma razon que los del disparo normal: el jobId
        // retenido es lo que hace que cada ronda reciba UN rescate y no uno por
        // pasada del barrido.
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    return true;
  }
}
