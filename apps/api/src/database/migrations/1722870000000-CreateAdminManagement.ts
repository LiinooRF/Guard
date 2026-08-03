import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdminManagement1722870000000 implements MigrationInterface {
  name = 'CreateAdminManagement1722870000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION admin_create_tenant_user(
        new_user_id uuid,
        new_email citext,
        new_username citext,
        new_password_hash text,
        new_given_name text,
        new_family_name text,
        new_role text
      )
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        current_tenant_id uuid := public.app_tenant_id();
        current_actor_id uuid := public.app_user_id();
      BEGIN
        IF current_tenant_id IS NULL OR current_actor_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.memberships
          JOIN public.users ON users.id = memberships.user_id
          WHERE memberships.tenant_id = current_tenant_id
            AND memberships.user_id = current_actor_id
            AND memberships.role_key = 'ADMIN'
            AND users.is_active
        ) THEN
          RAISE EXCEPTION 'tenant admin access denied' USING ERRCODE = '42501';
        END IF;
        IF new_role NOT IN ('SUPERVISOR', 'GUARDIA') THEN
          RAISE EXCEPTION 'invalid managed role' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.users (
          id, email, username, password_hash, given_name, family_name
        ) VALUES (
          new_user_id,
          new_email,
          new_username,
          new_password_hash,
          new_given_name,
          new_family_name
        );
        INSERT INTO public.memberships (tenant_id, user_id, role_key)
        VALUES (current_tenant_id, new_user_id, new_role);
        RETURN new_user_id;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          REVOKE ALL ON FUNCTION admin_create_tenant_user(
            uuid, citext, citext, text, text, text, text
          ) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION admin_create_tenant_user(
            uuid, citext, citext, text, text, text, text
          ) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION admin_create_tenant_user(uuid, citext, citext, text, text, text, text)
    `);
  }
}
