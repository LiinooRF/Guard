import { ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { ConfigService } from '@nestjs/config';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  const dataSource = { query: jest.fn() } as unknown as DataSource;
  const redis = {
    status: 'ready',
    connect: jest.fn(),
    ping: jest.fn(),
    lrange: jest.fn(),
    pipeline: jest.fn(),
  } as unknown as Redis;
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  } as unknown as ConfigService;

  beforeEach(() => jest.clearAllMocks());

  it('declara readiness solo cuando PostgreSQL y Redis responden', async () => {
    jest.mocked(dataSource.query).mockResolvedValue([{ '?column?': 1 }]);
    jest.mocked(redis.ping).mockResolvedValue('PONG');
    jest.mocked(redis.lrange).mockResolvedValue([]);

    await expect(new HealthController(dataSource, redis, config).ready()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', scan_sync_queue: 'ok' },
    });
  });

  it('responde 503 sin filtrar detalles internos cuando una dependencia falla', async () => {
    jest.mocked(dataSource.query).mockRejectedValue(new Error('credencial secreta'));
    jest.mocked(redis.ping).mockResolvedValue('PONG');
    jest.mocked(redis.lrange).mockResolvedValue([]);

    await expect(new HealthController(dataSource, redis, config).ready()).rejects.toEqual(
      new ServiceUnavailableException({
        status: 'unavailable',
        checks: { postgres: 'unavailable', redis: 'ok', scan_sync_queue: 'ok' },
      }),
    );
  });
});
