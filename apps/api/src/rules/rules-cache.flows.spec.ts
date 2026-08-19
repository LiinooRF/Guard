import { ConflictException } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import type { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EscalationService } from '../escalation/escalation.service';
import type { GpsPolicyService } from '../geo/gps-policy.service';
import { GuardService } from '../guard/guard.service';
import { BarridoVencidasService } from '../guard/rondas-vencidas.barrido';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { EnvioInformeService } from '../reports/envio-informe.service';
import { RulesLayersCache } from './rules-layers.cache';
import { RulesService } from './rules.service';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const PATROL_A = '22222222-2222-4222-8222-222222222222';
const PATROL_B = '33333333-3333-4333-8333-333333333333';

/** Simula el comportamiento anterior: habia manager ALS, pero no tenant cacheable. */
class CacheDisabledTenantContext extends TenantContextService {
  override get tenantId(): string | null {
    return null;
  }
}

const audit = {
  record: jest.fn().mockResolvedValue(undefined),
} as unknown as AuditService;

const rulesRow = [
  { scope: 'tenant', overrides: { complianceThreshold: 81 } },
];

const runner = (query: jest.Mock): QueryRunner =>
  ({
    manager: { query },
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  }) as unknown as QueryRunner;

function guardWith(context: TenantContextService, rules: RulesService): GuardService {
  return new GuardService(
    context,
    { enqueue: jest.fn() } as unknown as MailQueueService,
    rules,
    { notify: jest.fn() } as unknown as EscalationService,
    { assertPatrolStartAllowed: jest.fn() } as unknown as GpsPolicyService,
    { alCerrarRonda: jest.fn() } as unknown as EnvioInformeService,
  );
}

async function measureGuardFlows(context: TenantContextService) {
  const cache = new RulesLayersCache();
  const rules = new RulesService(context, audit, cache);
  const guard = guardWith(context, rules);
  let cascadeQueries = 0;

  const homeQuery = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("SELECT 'platform' AS scope")) {
      cascadeQueries += 1;
      return Promise.resolve(rulesRow);
    }
    if (sql.includes('FROM patrols p')) {
      return Promise.resolve([
        {
          id: PATROL_A,
          status: 'en_curso',
          scheduled_start_at: new Date(Date.now() - 60_000),
          scheduled_end_at: new Date(Date.now() + 3_600_000),
          started_at: new Date(Date.now() - 60_000),
          site_id: SITE_A,
          completed_checkpoint_count: 0,
          site_name: 'Sitio A',
          site_timezone: 'America/Santiago',
          route_name: 'Ruta A',
          estimated_duration_min: 30,
          checkpoints: [],
        },
      ]);
    }
    return Promise.resolve([]);
  });
  const scanQuery = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("SELECT 'platform' AS scope")) {
      cascadeQueries += 1;
      return Promise.resolve(rulesRow);
    }
    if (sql.includes('FROM patrols WHERE id')) {
      return Promise.resolve([
        {
          id: PATROL_A,
          status: 'completada',
          route_id: '44444444-4444-4444-8444-444444444444',
          expected_checkpoint_ids: [],
          site_id: SITE_A,
          started_at: new Date(Date.now() - 60_000),
          scheduled_start_at: new Date(Date.now() - 120_000),
          scheduled_end_at: new Date(Date.now() + 3_600_000),
          closed_at: new Date(Date.now() - 30_000),
        },
      ]);
    }
    return Promise.resolve([]);
  });

  await context.run(runner(homeQuery), TENANT_A, () => guard.getHome('guard-a'));
  await expect(
    context.run(runner(scanQuery), TENANT_A, () =>
      guard.registerScan(PATROL_A, 'guard-a', {
        uid: 'ABCD1234',
        method: 'nfc',
        clientScanId: '55555555-5555-4555-8555-555555555555',
      }),
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  await context.run(runner(homeQuery), TENANT_A, () => guard.getHome('guard-a'));

  return { cascadeQueries, stats: cache.stats() };
}

async function measureSweep(context: TenantContextService) {
  const cache = new RulesLayersCache();
  const rules = new RulesService(context, audit, cache);
  let cascadeQueries = 0;
  const tenantQuery = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("SELECT 'platform' AS scope")) {
      cascadeQueries += 1;
      return Promise.resolve(rulesRow);
    }
    if (sql.includes('FROM patrols WHERE id')) {
      return Promise.resolve([
        {
          status: 'completada',
          started_at: new Date(Date.now() - 60_000),
          scheduled_end_at: new Date(Date.now() + 3_600_000),
          site_id: SITE_A,
        },
      ]);
    }
    return Promise.resolve([]);
  });
  const dataSource = {
    query: jest.fn().mockResolvedValue([
      { tenant_id: TENANT_A, patrol_id: PATROL_A },
      { tenant_id: TENANT_A, patrol_id: PATROL_B },
    ]),
    createQueryRunner: () => runner(tenantQuery),
  } as unknown as DataSource;
  const sweep = new BarridoVencidasService(
    { upsertJobScheduler: jest.fn() } as never,
    dataSource,
    context,
    rules,
  );

  await expect(sweep.barrer()).resolves.toMatchObject({
    candidatas: 2,
    aunVivas: 2,
  });
  return { cascadeQueries, stats: cache.stats() };
}

describe('medicion de consultas de reglas en flujos criticos', () => {
  it('guard/home + escaneo + guard/home bajan de tres cascadas a una', async () => {
    const before = await measureGuardFlows(new CacheDisabledTenantContext());
    const after = await measureGuardFlows(new TenantContextService());

    expect(before.cascadeQueries).toBe(3);
    expect(after.cascadeQueries).toBe(1);
    expect(after.stats).toMatchObject({ misses: 1, hits: 2, writes: 1 });
    expect(JSON.stringify(after.stats)).not.toContain(TENANT_A);
    expect(JSON.stringify(after.stats)).not.toContain(SITE_A);
  });

  it('dos candidatas del mismo tenant/sitio en el barrido bajan de dos cascadas a una', async () => {
    const before = await measureSweep(new CacheDisabledTenantContext());
    const after = await measureSweep(new TenantContextService());

    expect(before.cascadeQueries).toBe(2);
    expect(after.cascadeQueries).toBe(1);
    expect(after.stats).toMatchObject({ misses: 1, hits: 1, writes: 1 });
    expect(JSON.stringify(after.stats)).not.toContain(TENANT_A);
    expect(JSON.stringify(after.stats)).not.toContain(SITE_A);
  });
});
