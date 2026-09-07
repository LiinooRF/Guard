import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import { DOMINIOS_NO_DESPACHABLES, dominioDe, reglaQueBloquea } from './mail-dominios';
import {
  MAIL_JOB_ATTEMPTS,
  MAIL_JOB_BACKOFF_MS,
  MAIL_JOB_NAME,
  MAIL_QUEUE_NAME,
} from './mail-queue.constants';
import type {
  MailJobData,
  EnqueueMailOptions,
  MotivoNoDespachado,
  ResultadoEncolado,
} from './mail-queue.types';

/** Recorta el motivo del fallo para que quepa en pantalla. */
const LARGO_MOTIVO = 240;

/**
 * Motivo del fallo listo para mostrar, sin direcciones de correo.
 *
 * El endpoint existe para que soporte pueda inspeccionar la dead-letter, y sin
 * el motivo no se puede: el 06-09-2026 habia 32 correos fallidos en produccion
 * y no habia forma de saber por que, ni desde el panel ni desde la API.
 *
 * Se enmascara el destinatario porque el mensaje del servidor SMTP suele
 * traerlo ("550 5.1.1 <alguien@empresa.cl> unknown"), y por aca pasan correos
 * de guardias y de clientes. El dominio se conserva: es lo que sirve para
 * diagnosticar y no identifica a nadie.
 */
export function motivoPublicable(motivo: string | undefined): string | null {
  if (!motivo) return null;
  const sinCorreos = motivo.replace(
    /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (_todo, dominio: string) => `***@${dominio}`,
  );
  return sinCorreos.length > LARGO_MOTIVO
    ? `${sinCorreos.slice(0, LARGO_MOTIVO)}…`
    : sinCorreos;
}

@Injectable()
export class MailQueueService {
  private readonly logger = new Logger(MailQueueService.name);

  constructor(
    @InjectQueue(MAIL_QUEUE_NAME)
    private readonly queue: Queue<MailJobData>,
    /**
     * La lista ya resuelta del entorno. Es un parametro REQUERIDO y no un
     * opcional con default vacio: un default vacio significa "no suprimas
     * nada", asi que cualquiera que construya el servicio sin pasarla
     * —un test, un modulo nuevo— apagaria la proteccion sin enterarse. Falla
     * cerrada, igual que las politicas de RLS.
     */
    @Inject(DOMINIOS_NO_DESPACHABLES)
    private readonly dominiosNoDespachables: readonly string[],
  ) {}

  /**
   * Acepta un correo para envio, o lo suprime.
   *
   * ESTE ES EL UNICO CUELLO POR DONDE PASA TODO EL CORREO DEL PRODUCTO:
   * informes, invitaciones, recuperacion de contrasena, escalamiento y avisos
   * de checklist. Por eso la supresion por dominio vive aca y no en el carril
   * del informe, que era donde estaba y solo protegia a uno de los cinco.
   *
   * Devuelve una union discriminada: 'suprimido' NO trae `jobId`, asi que el
   * compilador obliga a distinguirlo de 'encolado' antes de anotar nada. Ver
   * `ResultadoEncolado`.
   */
  async enqueue(data: MailJobData, options: EnqueueMailOptions): Promise<ResultadoEncolado> {
    if (data.to.trim().length === 0) {
      throw new Error('El destinatario de correo es obligatorio');
    }
    if (options.idempotencyKey.trim().length === 0) {
      throw new Error('La clave de idempotencia del correo es obligatoria');
    }

    // La supresion va ANTES de tocar Redis: un job creado es un jobId quemado
    // que no se puede reciclar, y ademas es la fila que el registro de envios
    // (#44) escribe al encolar. Suprimir despues dejaria las dos huellas de un
    // correo que nunca existio.
    const dominio = dominioDe(data.to);
    const regla = dominio === null ? null : reglaQueBloquea(dominio, this.dominiosNoDespachables);
    if (dominio === null || regla !== null) {
      const motivo: MotivoNoDespachado = dominio === null ? 'sin_dominio' : 'dominio_bloqueado';
      // Ni la direccion ni la clave de idempotencia (que la lleva dentro): solo
      // el tenant, el motivo y la REGLA que bloqueo — que es un valor que puso
      // el propio operador en la configuracion, no un dato de una persona.
      this.logger.warn(
        JSON.stringify({
          event: 'correo_suprimido',
          tenant_id: data.tenantId,
          motivo,
          regla,
        }),
      );
      return { estado: 'suprimido', motivo };
    }

    // No dejamos correos, tokens ni identificadores de negocio legibles en la
    // clave de Redis. El hash conserva la deduplicacion sin filtrar esos datos.
    const jobId = createHash('sha256').update(options.idempotencyKey).digest('hex');
    const job = await this.queue.add(MAIL_JOB_NAME, data, {
      jobId,
      attempts: MAIL_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: MAIL_JOB_BACKOFF_MS },
      // Retener completados preserva la idempotencia; retener fallidos forma la
      // dead-letter de BullMQ y permite que soporte los inspeccione/reintente.
      removeOnComplete: false,
      removeOnFail: false,
    });

    return { estado: 'encolado', jobId: job.id ?? jobId };
  }

  async supportStatus() {
    const [counts, failed] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      this.queue.getJobs(['failed'], 0, 49, false),
    ]);

    return {
      counts,
      failed: failed.map((job) => ({
        jobId: job.id,
        tenantId: job.data.tenantId,
        attemptsMade: job.attemptsMade,
        finishedOn: job.finishedOn ?? null,
        failedReason: motivoPublicable(job.failedReason),
      })),
    };
  }
}
