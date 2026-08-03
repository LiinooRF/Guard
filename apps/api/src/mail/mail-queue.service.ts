import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import {
  MAIL_JOB_ATTEMPTS,
  MAIL_JOB_BACKOFF_MS,
  MAIL_JOB_NAME,
  MAIL_QUEUE_NAME,
} from './mail-queue.constants';
import type { MailJobData, EnqueueMailOptions } from './mail-queue.types';

@Injectable()
export class MailQueueService {
  constructor(
    @InjectQueue(MAIL_QUEUE_NAME)
    private readonly queue: Queue<MailJobData>,
  ) {}

  async enqueue(data: MailJobData, options: EnqueueMailOptions) {
    if (data.to.trim().length === 0) {
      throw new Error('El destinatario de correo es obligatorio');
    }
    if (options.idempotencyKey.trim().length === 0) {
      throw new Error('La clave de idempotencia del correo es obligatoria');
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

    return { jobId: job.id ?? jobId };
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
      })),
    };
  }
}
