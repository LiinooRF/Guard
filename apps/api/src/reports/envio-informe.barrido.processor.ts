import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import {
  BarridoEnvioService,
  ENVIO_BARRIDO_QUEUE_NAME,
  type ResultadoBarrido,
} from './envio-informe.barrido';

/**
 * Worker del barrido de rondas sin informe (#86).
 *
 * VA EN SU PROPIA COLA, SEPARADA DE LA DEL DESPACHO
 * -------------------------------------------------
 * No es prolijidad: son dos cosas con reglas opuestas. El despacho corre CON
 * contexto de tenant, uno por ronda, y retiene sus jobs porque el jobId es su
 * idempotencia. El barrido corre SIN tenant, es uno solo para toda la
 * plataforma y se descarta al terminar. Mezclarlos en una cola obligaria al
 * worker del despacho a ramificar por `job.name` y a convivir con dos politicas
 * de retencion distintas; el dia que alguien agregue un job y olvide la rama, lo
 * que se rompe es el envio de informes.
 *
 * Ademas asi el barrido se apaga solo —sacando este processor— sin tocar el
 * camino normal de envio.
 *
 * ESTE WORKER NO ABRE TRANSACCION DE TENANT, Y ES CORRECTO
 * -------------------------------------------------------
 * Lo unico que consulta es `report_dispatch_backlog()`, que es SECURITY DEFINER
 * y devuelve solo pares (tenant_id, patrol_id). No lee ni escribe datos de
 * negocio. Quien si abre transaccion con `app.tenant_id` es el despacho que este
 * barrido encola, uno por ronda.
 */
@Processor(ENVIO_BARRIDO_QUEUE_NAME)
export class BarridoEnvioProcessor extends WorkerHost {
  private readonly logger = new Logger(BarridoEnvioProcessor.name);

  constructor(private readonly barrido: BarridoEnvioService) {
    super();
  }

  async process(): Promise<ResultadoBarrido> {
    return this.barrido.barrer();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    // Sin datos de personas ni de empresas: el barrido es cruza-tenants y su
    // fallo es un problema de plataforma, no de un cliente. Que falle no pierde
    // rondas: la proxima pasada vuelve a encontrar exactamente las mismas,
    // porque la lista sale de la base y no de un estado en memoria.
    this.logger.error(
      JSON.stringify({
        event: 'informe_barrido_fallo',
        job_id: job?.id ?? null,
        attempts: job?.attemptsMade ?? 0,
      }),
    );
  }
}
