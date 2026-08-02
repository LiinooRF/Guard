import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePlatformManagement1722783600000 implements MigrationInterface {
  name = 'CreatePlatformManagement1722783600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE platform_audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT platform_audit_action_check
          CHECK (action IN ('tenant.created', 'tenant.suspended', 'tenant.reactivated'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX platform_audit_tenant_created_idx
      ON platform_audit_log (tenant_id, created_at DESC)
    `);
    await queryRunner.query(`ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY platform_audit_tenant_isolation ON platform_audit_log
      FOR SELECT USING (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      CREATE FUNCTION assert_platform_superadmin(actor_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM public.platform_memberships
          JOIN public.users ON users.id = platform_memberships.user_id
          WHERE platform_memberships.user_id = actor_id
            AND platform_memberships.role_key = 'SUPERADMIN'
            AND users.is_active
        ) THEN
          RAISE EXCEPTION 'platform access denied' USING ERRCODE = '42501';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_list_tenants(actor_id uuid)
      RETURNS TABLE (
        id uuid,
        slug text,
        legal_name text,
        display_name text,
        status text,
        plan_key text,
        site_count integer,
        user_count integer,
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
          (SELECT count(*)::integer FROM public.sites WHERE sites.tenant_id = tenant.id),
          (SELECT count(*)::integer FROM public.memberships WHERE memberships.tenant_id = tenant.id),
          tenant.created_at
        FROM public.tenants tenant
        ORDER BY tenant.created_at DESC;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_create_tenant(
        actor_id uuid,
        new_tenant_id uuid,
        new_slug text,
        new_legal_name text,
        new_display_name text,
        new_plan_key text,
        admin_user_id uuid,
        admin_email citext,
        admin_password_hash text,
        admin_given_name text,
        admin_family_name text
      )
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);

        INSERT INTO public.tenants (
          id, slug, legal_name, display_name, plan_key
        ) VALUES (
          new_tenant_id, new_slug, new_legal_name, new_display_name, new_plan_key
        );
        INSERT INTO public.users (
          id, email, password_hash, given_name, family_name
        ) VALUES (
          admin_user_id, admin_email, admin_password_hash, admin_given_name, admin_family_name
        );
        INSERT INTO public.memberships (tenant_id, user_id, role_key)
        VALUES (new_tenant_id, admin_user_id, 'ADMIN');
        INSERT INTO public.platform_audit_log (tenant_id, actor_user_id, action, metadata)
        VALUES (
          new_tenant_id,
          actor_id,
          'tenant.created',
          jsonb_build_object('plan_key', new_plan_key)
        );

        RETURN new_tenant_id;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_set_tenant_status(
        actor_id uuid,
        target_tenant_id uuid,
        new_status text
      )
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        audit_action text;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        IF new_status NOT IN ('active', 'suspended') THEN
          RAISE EXCEPTION 'invalid tenant status' USING ERRCODE = '22023';
        END IF;

        UPDATE public.tenants
        SET status = new_status, updated_at = now()
        WHERE tenants.id = target_tenant_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
        END IF;

        audit_action := CASE new_status
          WHEN 'active' THEN 'tenant.reactivated'
          ELSE 'tenant.suspended'
        END;
        INSERT INTO public.platform_audit_log (tenant_id, actor_user_id, action)
        VALUES (target_tenant_id, actor_id, audit_action);
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          REVOKE ALL ON FUNCTION assert_platform_superadmin(uuid) FROM PUBLIC;
          REVOKE ALL ON FUNCTION platform_list_tenants(uuid) FROM PUBLIC;
          REVOKE ALL ON FUNCTION platform_create_tenant(
            uuid, uuid, text, text, text, text, uuid, citext, text, text, text
          ) FROM PUBLIC;
          REVOKE ALL ON FUNCTION platform_set_tenant_status(uuid, uuid, text) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION assert_platform_superadmin(uuid) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_list_tenants(uuid) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_create_tenant(
            uuid, uuid, text, text, text, text, uuid, citext, text, text, text
          ) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_set_tenant_status(uuid, uuid, text) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION platform_set_tenant_status(uuid, uuid, text)`);
    await queryRunner.query(`
      DROP FUNCTION platform_create_tenant(
        uuid, uuid, text, text, text, text, uuid, citext, text, text, text
      )
    `);
    await queryRunner.query(`DROP FUNCTION platform_list_tenants(uuid)`);
    await queryRunner.query(`DROP FUNCTION assert_platform_superadmin(uuid)`);
    await queryRunner.query(`DROP TABLE platform_audit_log`);
  }
}
