import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { PlatformService } from './platform.service';

const adminUrl = process.env.DATABASE_TEST_URL;
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describePlatform = adminUrl && appUrl ? describe : describe.skip;

describePlatform('PlatformService (integración)', () => {
  let admin: Client;
  let dataSource: DataSource;
  let platform: PlatformService;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await Promise.all([admin.connect(), dataSource.initialize()]);
    platform = new PlatformService(dataSource);
  });

  afterAll(async () => {
    await Promise.all([admin.end(), dataSource.destroy()]);
  });

  it('excluye guardias y suma recintos con supervisores activos', async () => {
    const billing = await platform.currentBilling(
      'c0000000-0000-4000-8000-000000000001',
    );
    const andina = billing.find(
      (tenant) => tenant.tenantId === 'a0000000-0000-4000-8000-000000000001',
    );

    expect(andina).toMatchObject({
      activeSiteCount: 1,
      activeSupervisorCount: 1,
      billableUnitCount: 2,
      netAmountClp: 30_000,
    });
  });

  it('nunca reduce el total al agregar una unidad', async () => {
    const result = await admin.query<{ monotonic: boolean }>(`
      WITH charges AS (
        SELECT
          units,
          calculate_progressive_charge(units, current_date) AS amount
        FROM generate_series(0, 100) units
      ),
      comparison AS (
        SELECT amount, lag(amount) OVER (ORDER BY units) AS previous_amount
        FROM charges
      )
      SELECT bool_and(amount >= previous_amount) AS monotonic
      FROM comparison
      WHERE previous_amount IS NOT NULL
    `);
    expect(result.rows[0]?.monotonic).toBe(true);
  });
});
