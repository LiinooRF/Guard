import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import type { RedisOptions } from 'ioredis';

import type { Env } from '../config/env';
import { MAIL_PROVIDER, type MailProvider } from './mail-provider';
import { MAIL_QUEUE_NAME } from './mail-queue.constants';
import { MailQueueService } from './mail-queue.service';
import { MailProcessor } from './mail.processor';
import { MailpitProvider } from './mailpit.provider';
import { SmtpProvider } from './smtp.provider';

type MailEnvironment = Pick<
  Env,
  | 'MAIL_DRIVER'
  | 'MAIL_FROM'
  | 'MAILPIT_HOST'
  | 'MAILPIT_PORT'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_USER'
  | 'SMTP_PASSWORD'
  | 'SMTP_SECURE'
>;

export function createMailProvider(env: MailEnvironment): MailProvider {
  if (env.MAIL_DRIVER === 'mailpit') {
    return new MailpitProvider({
      from: env.MAIL_FROM,
      host: env.MAILPIT_HOST,
      port: env.MAILPIT_PORT,
    });
  }

  if (!env.SMTP_HOST) {
    throw new Error('MAIL_DRIVER=smtp requiere SMTP_HOST');
  }

  return new SmtpProvider({
    from: env.MAIL_FROM,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER === undefined ? {} : { user: env.SMTP_USER }),
    ...(env.SMTP_PASSWORD === undefined ? {} : { password: env.SMTP_PASSWORD }),
  });
}

export function redisOptionsFromUrl(raw: string): RedisOptions {
  const url = new URL(raw);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(Number.isInteger(db) && db >= 0 ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: redisOptionsFromUrl(config.get('REDIS_URL', { infer: true })),
      }),
    }),
    BullModule.registerQueue({ name: MAIL_QUEUE_NAME }),
  ],
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createMailProvider({
          MAIL_DRIVER: config.get('MAIL_DRIVER', { infer: true }),
          MAIL_FROM: config.get('MAIL_FROM', { infer: true }),
          MAILPIT_HOST: config.get('MAILPIT_HOST', { infer: true }),
          MAILPIT_PORT: config.get('MAILPIT_PORT', { infer: true }),
          SMTP_HOST: config.get('SMTP_HOST', { infer: true }),
          SMTP_PORT: config.get('SMTP_PORT', { infer: true }),
          SMTP_USER: config.get('SMTP_USER', { infer: true }),
          SMTP_PASSWORD: config.get('SMTP_PASSWORD', { infer: true }),
          SMTP_SECURE: config.get('SMTP_SECURE', { infer: true }),
        }),
    },
    MailQueueService,
    MailProcessor,
  ],
  exports: [MAIL_PROVIDER, MailQueueService],
})
export class MailModule {}
