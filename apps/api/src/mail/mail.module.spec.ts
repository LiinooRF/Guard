import { MailpitProvider } from './mailpit.provider';
import { createMailProvider, redisOptionsFromUrl } from './mail.module';
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

describe('redisOptionsFromUrl', () => {
  it('preserva autenticacion, base y TLS para BullMQ', () => {
    expect(redisOptionsFromUrl('rediss://queue-user:secret@redis.example.test:6380/4')).toEqual({
      host: 'redis.example.test',
      port: 6380,
      username: 'queue-user',
      password: 'secret',
      db: 4,
      tls: {},
    });
  });
});
