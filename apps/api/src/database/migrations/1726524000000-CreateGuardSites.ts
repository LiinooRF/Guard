import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGuardSites1726524000000 implements MigrationInterface {
  name = 'CreateGuardSites1726524000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE guard_sites (
        tenant_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        role_key text NOT NULL DEFAULT 'GUARDIA'
          CONSTRAINT guard_sites_role_check CHECK (role_key = 'GUARDIA'),
        site_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, guard_id, site_id),
        FOREIGN KEY (tenant_id, guard_id, role_key)
          REFERENCES memberships(tenant_id, user_id, role_key) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES sites(tenant_id, id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX guard_sites_site_idx ON guard_sites (tenant_id, site_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX guard_sites_guard_idx ON guard_sites (tenant_id, guard_id)`,
    );

    await queryRunner.query(`ALTER TABLE guard_sites ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE guard_sites FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY guard_sites_isolation ON guard_sites
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON guard_sites TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE guard_sites`);
  }
}
