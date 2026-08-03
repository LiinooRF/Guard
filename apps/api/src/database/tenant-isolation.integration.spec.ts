import { Client } from 'pg';

const adminUrl = process.env.DATABASE_TEST_URL;
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = adminUrl && appUrl ? describe : describe.skip;

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000001';

describeDatabase('aislamiento RLS de todas las tablas tenant', () => {
  let admin: Client;
  let app: Client;
  let tenantTables: string[];

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await Promise.all([admin.connect(), app.connect()]);

    const result = await admin.query<{ table_name: string }>(`
      SELECT DISTINCT columns.table_name
      FROM information_schema.columns columns
      JOIN information_schema.tables tables
        ON tables.table_schema = columns.table_schema
       AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND columns.column_name = 'tenant_id'
        AND tables.table_type = 'BASE TABLE'
      ORDER BY columns.table_name
    `);
    tenantTables = result.rows.map((row) => row.table_name);
  });

  afterAll(async () => {
    await Promise.all([admin.end(), app.end()]);
  });

  it('el rol de aplicacion no puede saltarse RLS', async () => {
    const { rows } = await admin.query(
      `SELECT rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = 'voxia_app'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ bypass: false, super: false });
  });

  it('obliga RLS y al menos una política en el 100% de tablas con tenant_id', async () => {
    expect(tenantTables.length).toBeGreaterThan(0);

    for (const table of tenantTables) {
      const result = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policy_count: string;
      }>(
        `SELECT class.relrowsecurity, class.relforcerowsecurity,
                count(policy.policyname)::text AS policy_count
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
         LEFT JOIN pg_policies policy
           ON policy.schemaname = namespace.nspname AND policy.tablename = class.relname
         WHERE namespace.nspname = 'public' AND class.relname = $1
         GROUP BY class.relrowsecurity, class.relforcerowsecurity`,
        [table],
      );

      expect(result.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policy_count: expect.not.stringMatching(/^0$/),
      });
    }
  });

  it('un SELECT sin WHERE sólo devuelve el tenant activo en cada tabla', async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      try {
        for (const table of tenantTables) {
          const result = await app.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM "${table}"`,
          );
          expect(result.rows.every((row) => row.tenant_id === tenantId)).toBe(true);
        }
      } finally {
        await app.query('ROLLBACK');
      }
    }
  });

  it('rechaza cambiar filas propias al tenant de otra empresa', async () => {
    for (const table of tenantTables.filter((name) => name !== 'support_access_log')) {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);

      try {
        await expect(
          app.query(`UPDATE "${table}" SET tenant_id = $1 WHERE tenant_id = $2`, [
            TENANT_B,
            TENANT_A,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.query('ROLLBACK');
      }
    }
  });

  it('sin contexto tenant devuelve cero filas en todas las tablas', async () => {
    for (const table of tenantTables) {
      const result = await app.query(`SELECT tenant_id FROM "${table}"`);
      expect(result.rowCount).toBe(0);
    }
  });
});
