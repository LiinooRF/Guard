import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateActiveSessionCheck1722956400000 implements MigrationInterface {
  name = 'CreateActiveSessionCheck1722956400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION is_active_tenant_session(
        session_user_id uuid,
        session_tenant_id uuid,
        session_role text
      )
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT EXISTS (
          SELECT 1
          FROM public.tenants
          JOIN public.memberships ON memberships.tenant_id = tenants.id
          JOIN public.users ON users.id = memberships.user_id
          WHERE tenants.id = session_tenant_id
            AND tenants.status = 'active'
            AND memberships.user_id = session_user_id
            AND memberships.role_key = session_role
            AND users.is_active
        )
      $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          REVOKE ALL ON FUNCTION is_active_tenant_session(uuid, uuid, text) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION is_active_tenant_session(uuid, uuid, text) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION is_active_tenant_session(uuid, uuid, text)`);
  }
}
