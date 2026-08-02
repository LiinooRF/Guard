import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthActionTokens1723561200000 implements MigrationInterface {
  name = 'CreateAuthActionTokens1723561200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE auth_action_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose text NOT NULL CHECK (purpose IN ('invitation', 'password_reset')),
        token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX auth_action_tokens_user_purpose_idx
      ON auth_action_tokens (user_id, purpose, created_at DESC)
    `);
    await queryRunner.query(`ALTER TABLE auth_action_tokens ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE auth_action_tokens FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY auth_action_tokens_tenant_isolation ON auth_action_tokens
      FOR ALL USING (tenant_id = app_tenant_id())
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      CREATE FUNCTION lookup_recovery_identity(login_email text)
      RETURNS TABLE (
        user_id uuid,
        email text,
        tenant_id uuid
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT
          target.id,
          target.email::text,
          tenant_membership.tenant_id
        FROM public.users target
        LEFT JOIN LATERAL (
          SELECT membership.tenant_id
          FROM public.memberships membership
          WHERE membership.user_id = target.id
          ORDER BY membership.created_at
          LIMIT 1
        ) tenant_membership ON true
        WHERE target.is_active
          AND target.email = login_email::public.citext
          AND (
            tenant_membership.tenant_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM public.platform_memberships platform
              WHERE platform.user_id = target.id
            )
          )
        LIMIT 1
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION issue_auth_action_token(
        target_user_id uuid,
        target_tenant_id uuid,
        target_purpose text,
        target_token_hash text,
        target_expires_at timestamptz
      )
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        IF target_purpose NOT IN ('invitation', 'password_reset')
          OR target_token_hash !~ '^[a-f0-9]{64}$'
          OR target_expires_at <= now()
          OR NOT EXISTS (
            SELECT 1
            FROM public.users target
            WHERE target.id = target_user_id
              AND (
                (
                  target_tenant_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.memberships membership
                    WHERE membership.user_id = target.id
                      AND membership.tenant_id = target_tenant_id
                  )
                )
                OR (
                  target_tenant_id IS NULL
                  AND EXISTS (
                    SELECT 1 FROM public.platform_memberships platform
                    WHERE platform.user_id = target.id
                  )
                )
              )
          )
        THEN
          RAISE EXCEPTION 'invalid auth action token' USING ERRCODE = '22023';
        END IF;

        UPDATE public.auth_action_tokens
        SET used_at = now()
        WHERE user_id = target_user_id
          AND purpose = target_purpose
          AND used_at IS NULL;

        INSERT INTO public.auth_action_tokens (
          tenant_id, user_id, purpose, token_hash, expires_at
        ) VALUES (
          target_tenant_id,
          target_user_id,
          target_purpose,
          target_token_hash,
          target_expires_at
        );
      END
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION consume_auth_action_token(
        target_token_hash text,
        target_purpose text,
        target_password_hash text
      )
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        consumed_user_id uuid;
      BEGIN
        UPDATE public.auth_action_tokens
        SET used_at = now()
        WHERE token_hash = target_token_hash
          AND purpose = target_purpose
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING user_id INTO consumed_user_id;

        IF consumed_user_id IS NULL THEN
          RETURN NULL;
        END IF;

        UPDATE public.users
        SET password_hash = target_password_hash,
            is_active = true,
            updated_at = now()
        WHERE id = consumed_user_id;

        RETURN consumed_user_id;
      END
      $$
    `);

    for (const signature of [
      'lookup_recovery_identity(text)',
      'issue_auth_action_token(uuid, uuid, text, text, timestamptz)',
      'consume_auth_action_token(text, text, text)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await queryRunner.query(`REVOKE ALL ON auth_action_tokens FROM PUBLIC`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          REVOKE ALL ON auth_action_tokens FROM voxia_app;
          GRANT SELECT ON auth_action_tokens TO voxia_app;
          GRANT EXECUTE ON FUNCTION lookup_recovery_identity(text) TO voxia_app;
          GRANT EXECUTE ON FUNCTION
            issue_auth_action_token(uuid, uuid, text, text, timestamptz)
            TO voxia_app;
          GRANT EXECUTE ON FUNCTION consume_auth_action_token(text, text, text)
            TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION consume_auth_action_token(text, text, text)`);
    await queryRunner.query(
      `DROP FUNCTION issue_auth_action_token(uuid, uuid, text, text, timestamptz)`,
    );
    await queryRunner.query(`DROP FUNCTION lookup_recovery_identity(text)`);
    await queryRunner.query(`DROP TABLE auth_action_tokens`);
  }
}
