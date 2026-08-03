import type { Job } from 'bullmq';

import type { MailProvider } from './mail-provider';
import { MailProcessor } from './mail.processor';
import type { MailJobData } from './mail-queue.types';

describe('MailProcessor', () => {
  it('es el unico punto que entrega al transporte configurado', async () => {
    const provider = {
      send: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        accepted: ['admin@example.test'],
        rejected: [],
      }),
    } as unknown as MailProvider;
    const processor = new MailProcessor(provider);
    const data: MailJobData = {
      to: 'admin@example.test',
      tenantId: '00000000-0000-4000-8000-000000000001',
      template: { subject: 'Alerta {{site}}', text: 'Revisar {{site}}' },
      variables: { site: 'Bodega' },
    };

    await processor.process({ data } as Job<MailJobData>);

    expect(provider.send).toHaveBeenCalledWith(
      data.to,
      data.template,
      data.variables,
      data.tenantId,
    );
  });
});
