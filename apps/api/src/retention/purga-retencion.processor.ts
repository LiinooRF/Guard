import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { PURGA_RETENCION_QUEUE_NAME } from './purga-retencion.constantes';
import { PurgaRetencionService, type ResultadoPurga } from './purga-retencion.service';

/**
 * Worker de la purga por retencion (#219).
 *
 * VA EN SU PROPIA COLA. Mismo criterio que el barrido de informes: es un job
 * cruza-empresas, uno solo para toda la plataforma, que se descarta al terminar.
 * Mezclarlo con una cola que corre con contexto de tenant obligaria al worker a
 * ramificar por `job.name` y a convivir con dos politicas de retencion de jobs
 * distintas — y el dia que alguien olvide la rama, lo que se rompe es un borrado
 * irreversible.
 *
 * Y asi la purga se apaga sacando este processor del modulo, sin tocar nada de
 * lo que sirve evidencia.
 *
 * ESTE WORKER NO ABRE TRANSACCION DE TENANT, Y ES CORRECTO. Lo que consulta son
 * las funciones SECURITY DEFINER de la purga, que devuelven identificadores y
 * exigen justamente NO tener contexto de tenant. Quien si abre transaccion con
 * `app.tenant_id` es la lectura de las reglas de cada empresa, una por empresa.
 */
@Processor(PURGA_RETENCION_QUEUE_NAME)
export class PurgaRetencionProcessor extends WorkerHost {
  private readonly logger = new Logger(PurgaRetencionProcessor.name);

  constructor(private readonly purga: PurgaRetencionService) {
    super();
  }

  async process(): Promise<ResultadoPurga> {
    return this.purga.purgar();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    // Sin datos de personas ni de empresas: la purga es cruza-tenants y su fallo
    // es un problema de plataforma. Que falle no pierde nada —lo vencido sigue
    // vencido y la proxima pasada encuentra exactamente lo mismo—, pero que
    // falle SEGUIDO si importa: es el plazo legal que deja de cumplirse.
    this.logger.error(
      JSON.stringify({
        event: 'purga_retencion_fallo',
        job_id: job?.id ?? null,
        attempts: job?.attemptsMade ?? 0,
      }),
    );
  }
}
