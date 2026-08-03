import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenPlatformActorContext1723042800000 implements MigrationInterface {
  name = 'HardenPlatformActorContext1723042800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_platform_superadmin(actor_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        IF actor_id IS DISTINCT FROM public.app_user_id() OR NOT EXISTS (
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
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_platform_superadmin(actor_id uuid)
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
  }
}
