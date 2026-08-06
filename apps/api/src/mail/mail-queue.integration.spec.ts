import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';

import { resolverDominiosNoDespachables } from './mail-dominios';
import type { MailProvider } from './mail-provider';
import { MailQueueService } from './mail-queue.service';
import type { MailJobData } from './mail-queue.types';
import { redisOptionsFromUrl } from './mail.module';
import { MailProcessor } from './mail.processor';

const redisUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function isolatedMailRedisUrl(url: string): string {
  const parsed = new URL(url);
  // Auth limpia su DB para probar rate limits. BullMQ usa otra DB para que las
  // suites paralelas no puedan borrar jobs que todavia estan reintentando.
  parsed.pathname = '/15';
  return parsed.toString();
}

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
    const connection = redisOptionsFromUrl(isolatedMailRedisUrl(redisUrl!));
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('proveedor temporalmente caido'))
      .mockRejectedValueOnce(new Error('proveedor temporalmente caido'))
      .mockResolvedValue({
        messageId: 'message-1',
        accepted: ['jefa@empresa.cl'],
        rejected: [],
      });
    const processor = new MailProcessor({ send } as unknown as MailProvider);

    queue = new Queue<MailJobData>(queueName, { connection });
    events = new QueueEvents(queueName, { connection });
    worker = new Worker<MailJobData>(queueName, (job) => processor.process(job), {
      connection,
    });
    await events.waitUntilReady();

    // Con la lista de fabrica, igual que en produccion. El destinatario tiene
    // que ser un dominio despachable: `@example.test` —lo que usaba antes este
    // archivo— hoy se suprime por norma y el job no llegaria nunca a la cola.
    const service = new MailQueueService(queue, resolverDominiosNoDespachables({}));
    const data: MailJobData = {
      to: 'jefa@empresa.cl',
      tenantId: '00000000-0000-4000-8000-000000000001',
      template: { subject: 'Informe', text: 'Informe listo' },
      variables: {},
    };
    const options = { idempotencyKey: 'report:patrol-1:admin-1' };
    const enqueued = await service.enqueue(data, options);
    if (enqueued.estado !== 'encolado') {
      throw new Error(`el correo se suprimio (${enqueued.motivo}): no hay job que esperar`);
    }
    const job = await queue.getJob(enqueued.jobId);

    await expect(job?.waitUntilFinished(events, 15_000)).resolves.toMatchObject({
      messageId: 'message-1',
    });
    expect(send).toHaveBeenCalledTimes(3);

    const duplicate = await service.enqueue(data, options);
    expect(duplicate).toEqual({ estado: 'encolado', jobId: enqueued.jobId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(send).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('el correo a un dominio no despachable no toca Redis', async () => {
    // El unico test que lo comprueba contra un Redis de verdad: no basta con
    // que `add` no se llame en un mock — lo que importa es que no quede un job
    // esperando, porque un job creado quema un jobId irreciclable.
    const connection = redisOptionsFromUrl(isolatedMailRedisUrl(redisUrl!));
    const send = jest.fn();
    const processor = new MailProcessor({ send } as unknown as MailProvider);

    queue = new Queue<MailJobData>(queueName, { connection });
    events = new QueueEvents(queueName, { connection });
    worker = new Worker<MailJobData>(queueName, (job) => processor.process(job), {
      connection,
    });
    await events.waitUntilReady();

    const service = new MailQueueService(queue, resolverDominiosNoDespachables({}));
    const resultado = await service.enqueue(
      {
        to: 'admin@demo-andina.test',
        tenantId: '00000000-0000-4000-8000-000000000001',
        template: { subject: 'Invitacion', text: 'Activa tu acceso' },
        variables: {},
      },
      { idempotencyKey: 'invitation:demo-1' },
    );

    expect(resultado).toEqual({ estado: 'suprimido', motivo: 'dominio_bloqueado' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(send).not.toHaveBeenCalled();
    expect(await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).toEqual(
      expect.objectContaining({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 }),
    );
  }, 20_000);
});
