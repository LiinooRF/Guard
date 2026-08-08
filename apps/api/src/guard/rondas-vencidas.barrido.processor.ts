import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import {
  BARRIDO_VENCIDAS_QUEUE_NAME,
  BarridoVencidasService,
  type ResultadoBarridoVencidas,
} from './rondas-vencidas.barrido';

/**
 * Worker del barrido de rondas abandonadas (#265 / auditoria A1).
 *
 * En su PROPIA cola, separada del despacho de informes y del resto: es
 * cruza-tenant, es uno solo para toda la plataforma y se descarta al terminar.
 * Asi tambien se apaga solo —sacando este processor— sin tocar nada del camino
 * normal del guardia.
 *
 * Que falle una pasada no pierde nada: la siguiente vuelve a encontrar
 * exactamente las mismas rondas, porque la consulta es sobre el estado actual y
 * no sobre una cola de trabajo.
 */
@Processor(BARRIDO_VENCIDAS_QUEUE_NAME)
export class BarridoVencidasProcessor extends WorkerHost {
  private readonly logger = new Logger(BarridoVencidasProcessor.name);

  constructor(private readonly barrido: BarridoVencidasService) {
    super();
  }

  async process(): Promise<ResultadoBarridoVencidas> {
    return this.barrido.barrer();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    // Sin datos de personas ni de empresas: esto cruza tenants y su fallo es un
    // problema de plataforma, no de un cliente.
    this.logger.error(
      JSON.stringify({
        event: 'barrido_vencidas_fallo',
        intentos: job?.attemptsMade ?? null,
        message: job?.failedReason ?? 'desconocido',
      }),
    );
  }
}
