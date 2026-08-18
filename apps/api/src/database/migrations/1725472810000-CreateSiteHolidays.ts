import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feriados por recinto (#68/#101).
 *
 * No se usa un calendario global chileno: un recinto puede operar un feriado
 * legal y cerrar otro dia por mantenimiento. La fecha se interpreta en la zona
 * horaria del recinto y una fila siempre significa "dia no habil".
 */
export class CreateSiteHolidays1725472810000 implements MigrationInterface {
  name = 'CreateSiteHolidays1725472810000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE site_holidays (
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        holiday_date date NOT NULL,
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, site_id, holiday_date),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT site_holidays_name_check
          CHECK (name IS NULL OR length(trim(name)) BETWEEN 2 AND 120)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX site_holidays_date_idx ON site_holidays (tenant_id, holiday_date)`,
    );
    await queryRunner.query(`ALTER TABLE site_holidays ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE site_holidays FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY site_holidays_isolation ON site_holidays
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON site_holidays TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE site_holidays`);
  }
}
