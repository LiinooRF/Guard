import type { SentMessageInfo } from 'nodemailer';

import type { MailTransport } from './nodemailer-mail-provider';
import { MailpitProvider } from './mailpit.provider';
import { SmtpProvider } from './smtp.provider';

describe.each([
  [
    'smtp',
    (transport: MailTransport) =>
      new SmtpProvider({
        from: 'VoxIA <no-reply@example.test>',
        host: 'smtp.example.test',
        port: 587,
        secure: true,
        transport,
      }),
  ],
  [
    'mailpit',
    (transport: MailTransport) =>
      new MailpitProvider({
        from: 'VoxIA <no-reply@localhost>',
        host: 'localhost',
        port: 1025,
        transport,
      }),
  ],
])('%s provider', (_driver, makeProvider) => {
  it('envia mediante un transporte en memoria y renderiza las variables', async () => {
    const sendMail = jest.fn().mockResolvedValue({
      messageId: 'message-1',
      accepted: ['admin@example.test'],
      rejected: [],
    } satisfies Partial<SentMessageInfo>);
    const provider = makeProvider({ sendMail });

    await expect(
      provider.send(
        'admin@example.test',
        {
          subject: 'Informe de {{site}}',
          text: 'Cumplimiento: {{compliance}}%',
          html: '<strong>{{site}}</strong>',
        },
        { site: '<Bodega Norte>', compliance: 85 },
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toEqual({
      messageId: 'message-1',
      accepted: ['admin@example.test'],
      rejected: [],
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: expect.any(String),
      to: 'admin@example.test',
      subject: 'Informe de <Bodega Norte>',
      text: 'Cumplimiento: 85%',
      html: '<strong>&lt;Bodega Norte&gt;</strong>',
    });
  });

  it('falla antes del transporte si falta una variable', async () => {
    const sendMail = jest.fn();
    const provider = makeProvider({ sendMail });

    await expect(
      provider.send(
        'admin@example.test',
        { subject: 'Hola {{name}}', text: 'Texto' },
        {},
        '00000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toThrow('Falta la variable requerida por la plantilla: name');
    expect(sendMail).not.toHaveBeenCalled();
  });
});
