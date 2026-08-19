import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNfcCardToUsers1726437600000 implements MigrationInterface {
  name = 'AddNfcCardToUsers1726437600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS nfc_card_uid text,
        ADD COLUMN IF NOT EXISTS nfc_card_assigned_at timestamptz
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_nfc_card_uid_format_check'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_nfc_card_uid_format_check
            CHECK (
              nfc_card_uid IS NULL
              OR nfc_card_uid ~ '^[0-9A-F]{4,64}$'
            );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_active_nfc_card_uid_uniq
        ON users (nfc_card_uid)
        WHERE nfc_card_uid IS NOT NULL AND is_active = true
    `);

    await queryRunner.query(`DROP FUNCTION IF EXISTS authenticate_identity(text)`);
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
            OR (
              target_user.nfc_card_uid IS NOT NULL
              AND target_user.nfc_card_uid = upper(regexp_replace(login_identity, '[^0-9a-fA-F]', '', 'g'))
            )
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
            OR (
              target_user.nfc_card_uid IS NOT NULL
              AND target_user.nfc_card_uid = upper(regexp_replace(login_identity, '[^0-9a-fA-F]', '', 'g'))
            )
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
    await queryRunner.query(`DROP INDEX IF EXISTS users_active_nfc_card_uid_uniq`);
    await queryRunner.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_nfc_card_uid_format_check`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS nfc_card_assigned_at`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS nfc_card_uid`);
  }
}
