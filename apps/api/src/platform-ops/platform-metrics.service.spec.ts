import type { DataSource } from 'typeorm';

import type { MailQueueService } from '../mail/mail-queue.service';
import { DEFAULT_INACTIVITY_DAYS, PlatformMetricsService } from './platform-metrics.service';

const GLOBAL = {
  active_tenants: 12,
  suspended_tenants: 3,
  active_guards: 140,
  patrols_this_month: 980,
  avg_compliance_pct: '87.45',
  tenants_at_risk: 2,
  last_offline_sync_at: new Date('2026-08-03T10:00:00.000Z'),
  offline_sync_ops_24h: 51,
};

const TENANT = {
  tenant_id: 't-1',
  slug: 'andina',
  display_name: 'Andina',
  status: 'active' as const,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  active_guards: 12,
  patrols_this_month: 40,
  avg_compliance_pct: '91.00',
  compliance_sample: 38,
  last_activity_at: new Date('2026-07-20T00:00:00.000Z'),
  days_since_activity: 14,
  at_risk: true,
};

function fuenteDeDatos(query: jest.Mock) {
  return {
    transaction: (operacion: (manager: unknown) => Promise<unknown>) =>
      operacion({ query }),
  } as unknown as DataSource;
}

const colaOk = () =>
  ({
    supportStatus: jest.fn().mockResolvedValue({
      counts: { waiting: 4, active: 1, delayed: 0, failed: 2, completed: 900 },
      failed: [{ jobId: 'j1' }, { jobId: 'j2' }],
    }),
  }) as unknown as MailQueueService;

const consultaOk = (globales = GLOBAL, tenants: unknown[] = [TENANT]) =>
  jest
    .fn()
    .mockResolvedValueOnce([]) // set_config('app.user_id')
    .mockResolvedValueOnce([globales])
    .mockResolvedValueOnce(tenants);

function servicio(query: jest.Mock, cola: MailQueueService = colaOk()) {
  return new PlatformMetricsService(fuenteDeDatos(query), cola);
}

describe('PlatformMetricsService — metricas globales (#110)', () => {
  it('cruza tenants sin contexto de empresa: solo declara el actor y usa las funciones de plataforma', async () => {
    const query = consultaOk();
    await servicio(query).overview('super-1');

    const sqls = query.mock.calls.map(([sql]: [string]) => sql);
    expect(sqls[0]).toContain(`set_config('app.user_id'`);
    // Nunca app.tenant_id: la plataforma no se fabrica contexto de una empresa.
    expect(sqls.join(' ')).not.toContain('app.tenant_id');
    expect(sqls.some((sql) => sql.includes('platform_global_metrics'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('platform_tenant_metrics'))).toBe(true);
  });

  it('entrega el resumen y el detalle por empresa', async () => {
    const resultado = await servicio(consultaOk()).overview('super-1');

    expect(resultado.tenants).toEqual({ active: 12, suspended: 3, atRisk: 2 });
    expect(resultado.operation).toEqual({
      activeGuards: 140,
      patrolsThisMonth: 980,
      // numeric de PostgreSQL llega como string y el panel espera numero.
      avgCompliancePct: 87.45,
    });
    expect(resultado.byTenant[0]).toMatchObject({
      tenantId: 't-1',
      avgCompliancePct: 91,
      complianceSample: 38,
      daysSinceActivity: 14,
      atRisk: true,
    });
  });

  it('la empresa sin rondas del mes no inventa un cumplimiento de 0', async () => {
    const query = consultaOk(GLOBAL, [
      {
        ...TENANT,
        patrols_this_month: 0,
        avg_compliance_pct: null,
        compliance_sample: 0,
        last_activity_at: null,
        days_since_activity: null,
      },
    ]);
    const resultado = await servicio(query).overview('super-1');

    expect(resultado.byTenant[0]).toMatchObject({
      patrolsThisMonth: 0,
      avgCompliancePct: null,
      lastActivityAt: null,
      daysSinceActivity: null,
    });
  });

  it('la ventana de inactividad es parametro y viaja al SQL', async () => {
    const query = consultaOk();
    await servicio(query).overview('super-1', 30);

    const llamada = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('platform_tenant_metrics'),
    );
    expect(llamada?.[1]).toEqual(['super-1', 30]);
  });

  it('sin parametro usa el default de plataforma y lo devuelve explicito', async () => {
    const query = consultaOk();
    const resultado = await servicio(query).overview('super-1');

    expect(resultado.inactivityDays).toBe(DEFAULT_INACTIVITY_DAYS);
    const llamada = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('platform_global_metrics'),
    );
    expect(llamada?.[1]).toEqual(['super-1', DEFAULT_INACTIVITY_DAYS]);
  });

  it('reporta la salud de la cola de correo', async () => {
    const resultado = await servicio(consultaOk()).overview('super-1');

    expect(resultado.health).toMatchObject({
      mailQueue: {
        available: true,
        counts: { waiting: 4, active: 1, delayed: 0, failed: 2, completed: 900 },
        failedRecent: 2,
      },
      offlineSyncOps24h: 51,
    });
    expect(resultado.health.lastOfflineSyncAt).toEqual(GLOBAL.last_offline_sync_at);
  });

  it('si Redis no responde, las metricas siguen saliendo con la cola marcada', async () => {
    const cola = {
      supportStatus: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as MailQueueService;
    const resultado = await servicio(consultaOk(), cola).overview('super-1');

    expect(resultado.health.mailQueue).toEqual({ available: false });
    expect(resultado.tenants.active).toBe(12);
  });

  it('una plataforma vacia responde en ceros, no en undefined', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // platform_global_metrics sin fila
      .mockResolvedValueOnce([]);
    const resultado = await servicio(query).overview('super-1');

    expect(resultado.tenants).toEqual({ active: 0, suspended: 0, atRisk: 0 });
    expect(resultado.operation.avgCompliancePct).toBeNull();
    expect(resultado.byTenant).toEqual([]);
  });
});
