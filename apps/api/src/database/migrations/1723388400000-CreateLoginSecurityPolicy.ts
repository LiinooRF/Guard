import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLoginSecurityPolicy1723388400000 implements MigrationInterface {
  name = 'CreateLoginSecurityPolicy1723388400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenant_auth_policies (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        max_failed_attempts integer NOT NULL DEFAULT 5 CHECK (max_failed_attempts BETWEEN 3 AND 20),
        window_seconds integer NOT NULL DEFAULT 900 CHECK (window_seconds BETWEEN 60 AND 86400),
        base_lock_seconds integer NOT NULL DEFAULT 300 CHECK (base_lock_seconds BETWEEN 60 AND 86400),
        max_lock_seconds integer NOT NULL DEFAULT 3600 CHECK (max_lock_seconds BETWEEN base_lock_seconds AND 604800),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO tenant_auth_policies (tenant_id)
      SELECT id FROM tenants
    `);
    await queryRunner.query(`
      CREATE TABLE security_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        event_type text NOT NULL CHECK (event_type IN ('login_locked')),
        identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX security_events_tenant_created_idx
      ON security_events (tenant_id, created_at DESC)
    `);
    for (const table of ['tenant_auth_policies', 'security_events']) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_isolation ON ${table}
        FOR ALL USING (tenant_id = app_tenant_id())
        WITH CHECK (tenant_id = app_tenant_id())
      `);
    }

    await queryRunner.query(`
      CREATE FUNCTION record_login_lock(
        target_tenant_id uuid,
        target_user_id uuid,
        target_identity_hash text
      )
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        IF target_identity_hash !~ '^[a-f0-9]{64}$' OR NOT EXISTS (
          SELECT 1 FROM public.memberships
          WHERE memberships.tenant_id = target_tenant_id
            AND memberships.user_id = target_user_id
        ) THEN
          RAISE EXCEPTION 'invalid security event' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.security_events (
          tenant_id, user_id, event_type, identity_hash
        ) VALUES (
          target_tenant_id, target_user_id, 'login_locked', target_identity_hash
        );
      END
      $$
    `);

    await queryRunner.query(`DROP FUNCTION authenticate_identity(text)`);
    await queryRunner.query(`
      CREATE FUNCTION authenticate_identity(login_identity text)
      RETURNS TABLE (
        user_id uuid,
        password_hash text,
        tenant_id uuid,
        tenant_name text,
        tenant_status text,
        role_key text,
        is_platform_role boolean,
        max_failed_attempts integer,
        window_seconds integer,
        base_lock_seconds integer,
        max_lock_seconds integer
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT
          target_user.id,
          target_user.password_hash,
          membership.tenant_id,
          tenant.display_name,
          tenant.status,
          membership.role_key,
          false,
          COALESCE(policy.max_failed_attempts, 5),
          COALESCE(policy.window_seconds, 900),
          COALESCE(policy.base_lock_seconds, 300),
          COALESCE(policy.max_lock_seconds, 3600)
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        LEFT JOIN public.tenant_auth_policies policy ON policy.tenant_id = tenant.id
        WHERE target_user.is_active
          AND (
            target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext
          )
        UNION ALL
        SELECT
          target_user.id, target_user.password_hash, NULL::uuid, NULL::text, NULL::text,
          platform.role_key, true, 5, 900, 300, 3600
        FROM public.users target_user
        JOIN public.platform_memberships platform ON platform.user_id = target_user.id
        WHERE target_user.is_active
          AND (
            target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext
          )
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION authenticate_identity(text) FROM PUBLIC`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION record_login_lock(uuid, uuid, text) FROM PUBLIC`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE ON tenant_auth_policies TO sentrycore_app;
          GRANT SELECT ON security_events TO sentrycore_app;
          REVOKE INSERT, UPDATE, DELETE ON security_events FROM sentrycore_app;
          GRANT EXECUTE ON FUNCTION authenticate_identity(text) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION record_login_lock(uuid, uuid, text) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION authenticate_identity(text)`);
    await queryRunner.query(`DROP FUNCTION record_login_lock(uuid, uuid, text)`);
    await queryRunner.query(`DROP TABLE security_events`);
    await queryRunner.query(`DROP TABLE tenant_auth_policies`);
    await queryRunner.query(`
      CREATE FUNCTION authenticate_identity(login_identity text)
      RETURNS TABLE (
        user_id uuid,
        password_hash text,
        tenant_id uuid,
        tenant_name text,
        tenant_status text,
        role_key text,
        is_platform_role boolean
      )
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT target_user.id, target_user.password_hash, membership.tenant_id,
          tenant.display_name, tenant.status, membership.role_key, false
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        WHERE target_user.is_active
          AND (target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext)
        UNION ALL
        SELECT target_user.id, target_user.password_hash, NULL::uuid, NULL::text,
          NULL::text, platform.role_key, true
        FROM public.users target_user
        JOIN public.platform_memberships platform ON platform.user_id = target_user.id
        WHERE target_user.is_active
          AND (target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext)
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION authenticate_identity(text) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION authenticate_identity(text) TO sentrycore_app`);
  }
}
