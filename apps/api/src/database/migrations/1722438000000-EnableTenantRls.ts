import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EnableTenantRls1722438000000 implements MigrationInterface {
  name = 'EnableTenantRls1722438000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_tenant_id() RETURNS uuid
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$
        SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION app_user_id() RETURNS uuid
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$
        SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE support_access_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        superadmin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        reason text NOT NULL CONSTRAINT support_access_reason_check CHECK (length(trim(reason)) >= 10),
        started_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        ended_at timestamptz,
        CONSTRAINT support_access_expiry_check CHECK (expires_at > started_at),
        CONSTRAINT support_access_end_check CHECK (ended_at IS NULL OR ended_at >= started_at)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX support_access_log_tenant_id_idx ON support_access_log (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX support_access_log_actor_idx ON support_access_log (superadmin_user_id)`,
    );

    await queryRunner.query(`
      CREATE FUNCTION app_has_audited_support_access(target_tenant_id uuid) RETURNS boolean
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$
        SELECT EXISTS (
          SELECT 1
          FROM support_access_log access
          WHERE access.id = NULLIF(current_setting('app.support_access_id', true), '')::uuid
            AND access.tenant_id = target_tenant_id
            AND access.superadmin_user_id = app_user_id()
            AND access.started_at <= now()
            AND access.expires_at > now()
            AND access.ended_at IS NULL
        )
      $$
    `);

    for (const table of ['tenants', 'users', 'memberships', 'support_access_log']) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }

    await queryRunner.query(`
      CREATE POLICY tenants_isolation ON tenants
      FOR ALL
      USING (id = app_tenant_id() OR app_has_audited_support_access(id))
      WITH CHECK (id = app_tenant_id())
    `);

    await queryRunner.query(`
      CREATE POLICY memberships_isolation ON memberships
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      CREATE POLICY users_isolation ON users
      FOR SELECT
      USING (
        id = app_user_id()
        OR EXISTS (
          SELECT 1
          FROM memberships membership
          WHERE membership.user_id = users.id
            AND (
              membership.tenant_id = app_tenant_id()
              OR app_has_audited_support_access(membership.tenant_id)
            )
        )
      )
    `);
    await queryRunner.query(`
      CREATE POLICY users_insert_in_tenant ON users
      FOR INSERT
      WITH CHECK (app_tenant_id() IS NOT NULL)
    `);
    await queryRunner.query(`
      CREATE POLICY users_update_in_tenant ON users
      FOR UPDATE
      USING (
        id = app_user_id()
        OR EXISTS (
          SELECT 1 FROM memberships membership
          WHERE membership.user_id = users.id
            AND membership.tenant_id = app_tenant_id()
        )
      )
      WITH CHECK (
        id = app_user_id()
        OR EXISTS (
          SELECT 1 FROM memberships membership
          WHERE membership.user_id = users.id
            AND membership.tenant_id = app_tenant_id()
        )
      )
    `);

    await queryRunner.query(`
      CREATE POLICY support_access_tenant_audit ON support_access_log
      FOR SELECT
      USING (
        tenant_id = app_tenant_id()
        OR superadmin_user_id = app_user_id()
      )
    `);
    await queryRunner.query(`
      CREATE POLICY support_access_superadmin_create ON support_access_log
      FOR INSERT
      WITH CHECK (
        superadmin_user_id = app_user_id()
        AND EXISTS (
          SELECT 1 FROM platform_memberships platform
          WHERE platform.user_id = app_user_id()
            AND platform.role_key = 'SUPERADMIN'
        )
      )
    `);
    await queryRunner.query(`
      CREATE POLICY support_access_superadmin_end ON support_access_log
      FOR UPDATE
      USING (superadmin_user_id = app_user_id())
      WITH CHECK (superadmin_user_id = app_user_id())
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          REVOKE CREATE ON SCHEMA public FROM voxia_app;
          GRANT USAGE ON SCHEMA public TO voxia_app;
          GRANT SELECT, INSERT, UPDATE, DELETE
            ON tenants, users, memberships, support_access_log
            TO voxia_app;
          GRANT SELECT ON roles, permissions, role_permissions, platform_memberships TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY tenants_isolation ON tenants`);
    await queryRunner.query(`DROP POLICY users_isolation ON users`);
    await queryRunner.query(`DROP POLICY users_insert_in_tenant ON users`);
    await queryRunner.query(`DROP POLICY users_update_in_tenant ON users`);
    await queryRunner.query(`DROP POLICY memberships_isolation ON memberships`);

    for (const table of ['tenants', 'users', 'memberships']) {
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    }
    await queryRunner.query(`DROP TABLE support_access_log`);
    await queryRunner.query(`DROP FUNCTION app_has_audited_support_access(uuid)`);
    await queryRunner.query(`DROP FUNCTION app_user_id()`);
    await queryRunner.query(`DROP FUNCTION app_tenant_id()`);
  }
}
