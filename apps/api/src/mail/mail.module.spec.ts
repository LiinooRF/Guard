import { MailpitProvider } from './mailpit.provider';
import { createMailProvider } from './mail.module';
import { SmtpProvider } from './smtp.provider';

const baseEnvironment = {
  MAIL_FROM: 'VoxIA <no-reply@example.test>',
  MAILPIT_HOST: 'localhost',
  MAILPIT_PORT: 1025,
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: 587,
  SMTP_USER: 'user',
  SMTP_PASSWORD: 'secret',
  SMTP_SECURE: true,
} as const;

describe('createMailProvider', () => {
  it('selecciona Mailpit mediante MAIL_DRIVER', () => {
    expect(
      createMailProvider({ ...baseEnvironment, MAIL_DRIVER: 'mailpit' }),
    ).toBeInstanceOf(MailpitProvider);
  });

  it('selecciona SMTP mediante MAIL_DRIVER', () => {
    expect(
      createMailProvider({ ...baseEnvironment, MAIL_DRIVER: 'smtp' }),
    ).toBeInstanceOf(SmtpProvider);
  });
});
