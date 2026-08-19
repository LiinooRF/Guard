import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El `slug` de la empresa, disponible en el momento de autenticar.
 *
 * El guardia fija una vez el codigo de su empresa en el telefono y despues
 * entra solo con la tarjeta. Para eso el login tiene que poder elegir la
 * membresia por slug, y no lo puede resolver con un SELECT aparte: `tenants`
 * tiene RLS FORCE con `id = app_tenant_id()`, y durante el login todavia no hay
 * tenant en contexto, asi que esa consulta devolveria cero filas.
 *
 * La salida natural es que el slug venga de la misma funcion que ya se salta
 * RLS por ser SECURITY DEFINER. Ademas evita un viaje extra a la base en el
 * camino mas caliente del producto.
 *
 * Se redefine ENTERA por la misma razon que en #1726610400000: es la funcion de
 * la que sale toda la autenticacion, sus dos consumidores leen las columnas por
 * nombre, y recrearla a medias deja al producto sin login. Lo unico que cambia
 * respecto de la version anterior es `tenant_slug` al final.
 */
export class AddTenantSlugToAuthLookup1726696800000 implements MigrationInterface {
  name = 'AddTenantSlugToAuthLookup1726696800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
        max_lock_seconds integer,
        nfc_pin_hash text,
        tenant_slug text
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
          COALESCE(policy.max_lock_seconds, 3600),
          target_user.nfc_pin_hash,
          tenant.slug
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
          platform.role_key, true, 5, 900, 300, 3600, target_user.nfc_pin_hash, NULL::text
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

  public async down(queryRunner: QueryRunner): Promise<void> {
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
        max_lock_seconds integer,
        nfc_pin_hash text
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
          COALESCE(policy.max_lock_seconds, 3600),
          target_user.nfc_pin_hash
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
          platform.role_key, true, 5, 900, 300, 3600, target_user.nfc_pin_hash
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
}
