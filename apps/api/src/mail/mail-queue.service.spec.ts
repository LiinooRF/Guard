import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import {
  MAIL_JOB_ATTEMPTS,
  MAIL_JOB_BACKOFF_MS,
  MAIL_JOB_NAME,
} from './mail-queue.constants';
import { MailQueueService } from './mail-queue.service';
import type { MailJobData } from './mail-queue.types';

const data: MailJobData = {
  to: 'admin@example.test',
  tenantId: '00000000-0000-4000-8000-000000000001',
  template: { subject: 'Informe', text: 'Listo' },
  variables: {},
};

describe('MailQueueService', () => {
  it('encola fuera del request con reintentos, backoff y retencion', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-id' }),
    } as unknown as Queue<MailJobData>;
    const service = new MailQueueService(queue);

    await expect(
      service.enqueue(data, { idempotencyKey: 'report:patrol-1:admin-1' }),
    ).resolves.toEqual({ jobId: 'job-id' });

    expect(queue.add).toHaveBeenCalledWith(
      MAIL_JOB_NAME,
      data,
      expect.objectContaining({
        attempts: MAIL_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: MAIL_JOB_BACKOFF_MS },
        removeOnComplete: false,
        removeOnFail: false,
      }),
    );
  });

  it('produce el mismo job id sin exponer la clave de negocio', async () => {
    const add = jest.fn().mockImplementation(
      (_name: string, _data: MailJobData, options: { jobId: string }) =>
        Promise.resolve({ id: options.jobId }),
    );
    const service = new MailQueueService({ add } as unknown as Queue<MailJobData>);
    const idempotencyKey = 'report:patrol-1:admin@example.test';
    const expected = createHash('sha256').update(idempotencyKey).digest('hex');

    const first = await service.enqueue(data, { idempotencyKey });
    const second = await service.enqueue(data, { idempotencyKey });

    expect(first.jobId).toBe(expected);
    expect(second.jobId).toBe(expected);
    expect(expected).not.toContain('admin');
  });

  it('expone fallidos a soporte sin destinatario ni contenido', async () => {
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, failed: 1 }),
      getJobs: jest.fn().mockResolvedValue([
        {
          id: 'failed-job',
          data,
          attemptsMade: MAIL_JOB_ATTEMPTS,
          finishedOn: 1_725_000_000_000,
        },
      ]),
    } as unknown as Queue<MailJobData>;
    const status = await new MailQueueService(queue).supportStatus();

    expect(status).toEqual({
      counts: { waiting: 1, failed: 1 },
      failed: [{
        jobId: 'failed-job',
        tenantId: data.tenantId,
        attemptsMade: MAIL_JOB_ATTEMPTS,
        finishedOn: 1_725_000_000_000,
      }],
    });
    expect(JSON.stringify(status)).not.toContain(data.to);
    expect(JSON.stringify(status)).not.toContain(data.template.text);
  });
});
