import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { ALERTS_QUEUE_NAME } from './alerts-queue.constants';
import type { AlertDetectionJob } from './alerts-queue.types';
import { AlertsService } from './alerts.service';

@Processor(ALERTS_QUEUE_NAME)
export class AlertsProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertsProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly alerts: AlertsService,
  ) { super(); }

  async process(job: Job<AlertDetectionJob>) {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.manager.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id', '', true),
                set_config('app.support_access_id', '', true)`,
        [job.data.tenantId],
      );
      const result = await this.tenantContext.run(runner, () =>
        this.alerts.detectScheduled(job.data.patrolId, job.data.kind),
      );
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally { await runner.release(); }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<AlertDetectionJob> | undefined) {
    if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;
    this.logger.error(JSON.stringify({
      event: 'alerta_operativa_dead_letter', tenant_id: job.data.tenantId,
      patrol_id: job.data.patrolId, kind: job.data.kind,
    }));
  }
}
