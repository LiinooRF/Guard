import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { MAIL_PROVIDER, type MailProvider } from './mail-provider';
import { MAIL_QUEUE_NAME } from './mail-queue.constants';
import type { MailJobData } from './mail-queue.types';

@Processor(MAIL_QUEUE_NAME)
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(@Inject(MAIL_PROVIDER) private readonly provider: MailProvider) {
    super();
  }

  process(job: Job<MailJobData>) {
    // El argumento de adjuntos solo se pasa cuando existe: los correos sin
    // adjunto conservan la firma original de MailProvider.send.
    return job.data.attachments === undefined
      ? this.provider.send(
          job.data.to,
          job.data.template,
          job.data.variables,
          job.data.tenantId,
        )
      : this.provider.send(
          job.data.to,
          job.data.template,
          job.data.variables,
          job.data.tenantId,
          job.data.attachments,
        );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MailJobData> | undefined) {
    if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;

    this.logger.error(
      JSON.stringify({
        event: 'mail_dead_letter',
        tenant_id: job.data.tenantId,
        job_id: job.id,
        attempts: job.attemptsMade,
      }),
    );
  }
}
