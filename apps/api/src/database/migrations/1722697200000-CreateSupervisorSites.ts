import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSupervisorSites1722697200000 implements MigrationInterface {
  name = 'CreateSupervisorSites1722697200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE supervisor_sites (
        tenant_id uuid NOT NULL,
        supervisor_id uuid NOT NULL,
        role_key text NOT NULL DEFAULT 'SUPERVISOR'
          CONSTRAINT supervisor_sites_role_check CHECK (role_key = 'SUPERVISOR'),
        site_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, supervisor_id, site_id),
        FOREIGN KEY (tenant_id, supervisor_id, role_key)
          REFERENCES memberships(tenant_id, user_id, role_key) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES sites(tenant_id, id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX supervisor_sites_site_idx ON supervisor_sites (tenant_id, site_id)`,
    );

    await queryRunner.query(`ALTER TABLE supervisor_sites ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE supervisor_sites FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY supervisor_sites_isolation ON supervisor_sites
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON supervisor_sites TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE supervisor_sites`);
  }
}
