import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';

import type { MailProvider } from './mail-provider';
import { MailQueueService } from './mail-queue.service';
import type { MailJobData } from './mail-queue.types';
import { redisOptionsFromUrl } from './mail.module';
import { MailProcessor } from './mail.processor';

const redisUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('MailQueueService (integracion Redis)', () => {
  const queueName = `mail-delivery-test-${randomUUID()}`;
  let queue: Queue<MailJobData>;
  let events: QueueEvents;
  let worker: Worker<MailJobData>;

  afterEach(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await Promise.all([events.close(), queue.close()]);
  });

  it('reintenta al recuperarse el proveedor y no reenvia la misma operacion', async () => {
    const connection = redisOptionsFromUrl(redisUrl!);
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('proveedor temporalmente caido'))
      .mockRejectedValueOnce(new Error('proveedor temporalmente caido'))
      .mockResolvedValue({
        messageId: 'message-1',
        accepted: ['admin@example.test'],
        rejected: [],
      });
    const processor = new MailProcessor({ send } as unknown as MailProvider);

    queue = new Queue<MailJobData>(queueName, { connection });
    events = new QueueEvents(queueName, { connection });
    worker = new Worker<MailJobData>(queueName, (job) => processor.process(job), {
      connection,
    });
    await events.waitUntilReady();

    const service = new MailQueueService(queue);
    const data: MailJobData = {
      to: 'admin@example.test',
      tenantId: '00000000-0000-4000-8000-000000000001',
      template: { subject: 'Informe', text: 'Informe listo' },
      variables: {},
    };
    const options = { idempotencyKey: 'report:patrol-1:admin-1' };
    const enqueued = await service.enqueue(data, options);
    const job = await queue.getJob(enqueued.jobId);

    await expect(job?.waitUntilFinished(events, 15_000)).resolves.toMatchObject({
      messageId: 'message-1',
    });
    expect(send).toHaveBeenCalledTimes(3);

    const duplicate = await service.enqueue(data, options);
    expect(duplicate.jobId).toBe(enqueued.jobId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(send).toHaveBeenCalledTimes(3);
  }, 20_000);
});
