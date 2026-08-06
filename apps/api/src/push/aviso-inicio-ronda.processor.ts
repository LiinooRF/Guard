import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { AVISO_INICIO_QUEUE_NAME } from './aviso-inicio-ronda.constants';
import {
  AvisoInicioRondaService,
  type ResultadoAvisoInicio,
} from './aviso-inicio-ronda.service';

/**
 * Worker del barrido de rondas por comenzar (#43).
 *
 * VA EN SU PROPIA COLA, SEPARADA DE LA DE ENTREGA — el mismo criterio que separa
 * el barrido de informes del despacho (#86), y por las mismas razones opuestas:
 *
 *   - `push-delivery` entrega UN aviso a UN destinatario, con contexto de tenant,
 *     y RETIENE sus jobs porque el jobId es su idempotencia.
 *   - `patrol-start-notice` es una pasada periodica, una sola para toda la
 *     plataforma, que corre sin tenant y se descarta al terminar.
 *
 * Mezclarlas obligaria al worker de entrega a ramificar por `job.name` y a
 * convivir con dos politicas de retencion; el dia que alguien agregue un job y
 * olvide la rama, lo que se rompe es la entrega de las alertas de panico.
 *
 * Ademas asi el aviso de inicio se apaga solo —sacando este processor— sin tocar
 * el camino de entrega.
 *
 * ESTE WORKER NO ABRE TRANSACCION DE TENANT, y es correcto: lo unico que consulta
 * directo es `patrol_start_notice_backlog()`, que es SECURITY DEFINER y devuelve
 * solo pares (tenant_id, patrol_id). Quien si abre transaccion con `app.tenant_id`
 * es el propio servicio, una por empresa.
 */
@Processor(AVISO_INICIO_QUEUE_NAME)
export class AvisoInicioRondaProcessor extends WorkerHost {
  private readonly logger = new Logger(AvisoInicioRondaProcessor.name);

  constructor(private readonly aviso: AvisoInicioRondaService) {
    super();
  }

  async process(): Promise<ResultadoAvisoInicio> {
    return this.aviso.barrer();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    // Sin datos de personas ni de empresas: el barrido cruza tenants y su fallo
    // es un problema de plataforma, no de un cliente.
    //
    // Que falle una pasada no pierde avisos mientras quede ventana: la lista sale
    // de la base y no de un estado en memoria, asi que la pasada siguiente vuelve
    // a encontrar las mismas rondas. Lo que si se pierde es el aviso de una ronda
    // que arranque en el intervalo, y por eso esto es ERROR y no WARN.
    this.logger.error(
      JSON.stringify({
        event: 'aviso_inicio_barrido_fallo',
        job_id: job?.id ?? null,
        attempts: job?.attemptsMade ?? 0,
      }),
    );
  }
}
