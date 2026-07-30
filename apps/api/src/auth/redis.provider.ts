import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const AUTH_REDIS = Symbol('AUTH_REDIS');

export const authRedisProvider: FactoryProvider<Redis> = {
  provide: AUTH_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis(config.getOrThrow<string>('REDIS_URL'), {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    }),
};
