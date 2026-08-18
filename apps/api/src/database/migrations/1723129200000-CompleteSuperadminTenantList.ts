import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CompleteSuperadminTenantList1723129200000 implements MigrationInterface {
  name = 'CompleteSuperadminTenantList1723129200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE subscription_plans (
        key text PRIMARY KEY,
        name text NOT NULL,
        user_limit integer NOT NULL CHECK (user_limit > 0),
        site_limit integer NOT NULL CHECK (site_limit > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO subscription_plans (key, name, user_limit, site_limit) VALUES
        ('base', 'Base', 25, 5),
        ('pro', 'Pro', 100, 25)
    `);
    await queryRunner.query(`
      ALTER TABLE tenants
      ADD CONSTRAINT tenants_plan_key_fkey
      FOREIGN KEY (plan_key) REFERENCES subscription_plans(key) ON DELETE RESTRICT
    `);

    await queryRunner.query(`DROP FUNCTION platform_list_tenants(uuid)`);
    await queryRunner.query(`
      CREATE FUNCTION platform_list_tenants(actor_id uuid)
      RETURNS TABLE (
        id uuid,
        slug text,
        legal_name text,
        display_name text,
        status text,
        plan_key text,
        plan_name text,
        user_limit integer,
        site_limit integer,
        site_count integer,
        user_count integer,
        monthly_patrol_count integer,
        last_patrol_at timestamptz,
        created_at timestamptz
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        SELECT
          tenant.id,
          tenant.slug,
          tenant.legal_name,
          tenant.display_name,
          tenant.status,
          tenant.plan_key,
          subscription_plans.name,
          subscription_plans.user_limit,
          subscription_plans.site_limit,
          (SELECT count(*)::integer FROM public.sites WHERE sites.tenant_id = tenant.id),
          (SELECT count(*)::integer FROM public.memberships WHERE memberships.tenant_id = tenant.id),
          (
            SELECT count(*)::integer
            FROM public.patrols
            WHERE patrols.tenant_id = tenant.id
              AND patrols.scheduled_start_at >= date_trunc('month', now())
          ),
          (
            SELECT max(patrols.scheduled_start_at)
            FROM public.patrols
            WHERE patrols.tenant_id = tenant.id
          ),
          tenant.created_at
        FROM public.tenants tenant
        JOIN public.subscription_plans ON subscription_plans.key = tenant.plan_key
        ORDER BY tenant.created_at DESC;
      END
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION platform_list_tenants(uuid) FROM PUBLIC`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT EXECUTE ON FUNCTION platform_list_tenants(uuid) TO sentrycore_app;
        END IF;
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
        is_platform_role boolean
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
          false
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        WHERE target_user.is_active
          AND (
            target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext
          )

        UNION ALL

        SELECT
          target_user.id,
          target_user.password_hash,
          NULL::uuid,
          NULL::text,
          NULL::text,
          platform.role_key,
          true
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
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT EXECUTE ON FUNCTION authenticate_identity(text) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION authenticate_identity(text)`);
    await queryRunner.query(`
      CREATE FUNCTION authenticate_identity(login_identity text)
      RETURNS TABLE (
        user_id uuid,
        password_hash text,
        tenant_id uuid,
        tenant_name text,
        role_key text,
        is_platform_role boolean
      )
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT target_user.id, target_user.password_hash, membership.tenant_id,
          tenant.display_name, membership.role_key, false
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        WHERE target_user.is_active AND tenant.status = 'active'
          AND (target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext)
        UNION ALL
        SELECT target_user.id, target_user.password_hash, NULL::uuid, NULL::text,
          platform.role_key, true
        FROM public.users target_user
        JOIN public.platform_memberships platform ON platform.user_id = target_user.id
        WHERE target_user.is_active
          AND (target_user.email = login_identity::public.citext
            OR target_user.username = login_identity::public.citext)
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION authenticate_identity(text) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION authenticate_identity(text) TO sentrycore_app`);

    await queryRunner.query(`DROP FUNCTION platform_list_tenants(uuid)`);
    await queryRunner.query(`
      CREATE FUNCTION platform_list_tenants(actor_id uuid)
      RETURNS TABLE (
        id uuid, slug text, legal_name text, display_name text, status text,
        plan_key text, site_count integer, user_count integer, created_at timestamptz
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        SELECT tenant.id, tenant.slug, tenant.legal_name, tenant.display_name,
          tenant.status, tenant.plan_key,
          (SELECT count(*)::integer FROM public.sites WHERE sites.tenant_id = tenant.id),
          (SELECT count(*)::integer FROM public.memberships WHERE memberships.tenant_id = tenant.id),
          tenant.created_at
        FROM public.tenants tenant ORDER BY tenant.created_at DESC;
      END
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION platform_list_tenants(uuid) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION platform_list_tenants(uuid) TO sentrycore_app`);
    await queryRunner.query(`ALTER TABLE tenants DROP CONSTRAINT tenants_plan_key_fkey`);
    await queryRunner.query(`DROP TABLE subscription_plans`);
  }
}
