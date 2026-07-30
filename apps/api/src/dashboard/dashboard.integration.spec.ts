import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { DashboardService } from './dashboard.service';

const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

describeDatabase('DashboardService (RLS)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function inTenant<T>(
    tenantId: string,
    userId: string,
    operation: (service: DashboardService) => Promise<T>,
  ) {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [tenantId, userId],
      );
      const context = new TenantContextService();
      return await context.run(runner, () => operation(new DashboardService(context)));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('limita al supervisor a sus recintos asignados', async () => {
    const overview = await inTenant(
      'a0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000008',
      (service) =>
        service.getTenantOverview('a0000000-0000-4000-8000-000000000008', 'SUPERVISOR'),
    );

    expect(overview).toMatchObject({
      scope: 'assigned_sites',
      metrics: { sites: 1, guards: 1 },
    });
    expect(overview.patrols).toHaveLength(1);
  });

  it('no muestra recintos de otro tenant sin asignación', async () => {
    const overview = await inTenant(
      'b0000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000002',
      (service) =>
        service.getTenantOverview('a0000000-0000-4000-8000-000000000008', 'SUPERVISOR'),
    );

    expect(overview.metrics.sites).toBe(0);
    expect(overview.patrols).toHaveLength(0);
  });
});
