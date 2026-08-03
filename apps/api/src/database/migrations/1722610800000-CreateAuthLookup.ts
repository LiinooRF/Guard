import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthLookup1722610800000 implements MigrationInterface {
  name = 'CreateAuthLookup1722610800000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
          membership.role_key,
          false
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        WHERE target_user.is_active
          AND tenant.status = 'active'
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          GRANT EXECUTE ON FUNCTION authenticate_identity(text) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION authenticate_identity(text)`);
  }
}
