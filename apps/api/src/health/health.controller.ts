import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AUTH_REDIS } from '../auth/redis.provider';

/**
 * `/health` responde si el proceso esta vivo. `/ready` responde si puede
 * atender trafico (base de datos y Redis alcanzables). Docker y Dokploy usan
 * `/ready` para no enrutar hacia un contenedor que todavia no sirve.
 *
 * Ver issue #6, sub-issue de observabilidad.
 */
@Controller()
@SkipTenantContext()
@Public()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'sentrycore-api', ts: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    const checks = {
      postgres: await this.checkPostgres(),
      redis: await this.checkRedis(),
      scan_sync_queue: await this.checkScanSyncQueue(),
    };

    if (checks.postgres !== 'ok' || checks.redis !== 'ok') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }

    return { status: 'ok', checks };
  }

  private async checkPostgres(): Promise<'ok' | 'unavailable'> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }

  private async checkRedis(): Promise<'ok' | 'unavailable'> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      return (await this.redis.ping()) === 'PONG' ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  private async checkScanSyncQueue(): Promise<'ok' | 'delayed' | 'unavailable'> {
    try {
      const queue = this.config.get<string>('SCAN_SYNC_QUEUE_NAME', 'scan-sync');
      const jobIds = await this.redis.lrange(`bull:${queue}:wait`, 0, -1);
      if (jobIds.length === 0) return 'ok';

      const pipeline = this.redis.pipeline();
      for (const jobId of jobIds) pipeline.hget(`bull:${queue}:${jobId}`, 'timestamp');
      const timestamps = (await pipeline.exec())
        ?.map(([, value]) => Number(value))
        .filter((value) => Number.isFinite(value));
      if (!timestamps?.length) return 'ok';

      const lagSeconds = Math.max(0, Math.floor((Date.now() - Math.min(...timestamps)) / 1_000));
      const threshold = this.config.get<number>('SCAN_SYNC_LAG_ALERT_SECONDS', 300);
      if (lagSeconds <= threshold) return 'ok';

      this.logger.warn(
        JSON.stringify({
          event: 'scan_sync_queue_delayed',
          lag_seconds: lagSeconds,
          threshold_seconds: threshold,
          pending_jobs: jobIds.length,
        }),
      );
      return 'delayed';
    } catch {
      return 'unavailable';
    }
  }
}
