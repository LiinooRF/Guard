import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PIN OPCIONAL para el login pasivo con tarjeta NFC.
 *
 * El login por tarjeta autentica con el UID, y un UID se clona con cualquier
 * telefono: quien consigue la tarjeta entra como ese guardia. Este PIN es el
 * segundo factor —algo que se sabe, ademas de algo que se tiene— y es
 * **opcional a proposito**: la empresa que quiera velocidad en la garita lo deja
 * vacio y el login sigue siendo solo tarjeta, como hoy.
 *
 * Se guarda HASHEADO con el mismo argon2id que la contraseña, por la misma
 * razon: un PIN en texto plano en la base convierte cualquier lectura de
 * `users` —un volcado, un backup, un SELECT de soporte— en una llave del
 * carril del guardia. Que sean cuatro digitos no lo hace menos secreto.
 *
 * `nfc_pin_hash` NULL significa "sin PIN", que es distinto de "PIN vacio": el
 * codigo nunca debe tratar la cadena vacia como ausencia.
 */
export class AddNfcPinToUsers1726610400000 implements MigrationInterface {
  name = 'AddNfcPinToUsers1726610400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS nfc_pin_hash text,
        ADD COLUMN IF NOT EXISTS nfc_pin_updated_at timestamptz
    `);

    /*
     * Lo que se guarda es un hash de argon2id, no el PIN. El CHECK lo exige por
     * forma: si alguna vez alguien escribe el PIN crudo por error, la base lo
     * rechaza en vez de aceptarlo en silencio. `length()` y no un `{m,n}` en el
     * regex, que en PostgreSQL solo admite hasta 255 y compila al evaluar.
     */
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_nfc_pin_hash_format_check'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_nfc_pin_hash_format_check
            CHECK (
              nfc_pin_hash IS NULL
              OR (nfc_pin_hash LIKE '$argon2id$%' AND length(nfc_pin_hash) BETWEEN 40 AND 512)
            );
        END IF;
      END $$;
    `);

    /*
     * El rol de la aplicacion ya tiene los cuatro permisos sobre toda tabla por
     * los default privileges de `01-app-role.sh`: escribir un GRANT aca no
     * acotaria nada. Lo que si hace falta es que NADIE pueda leer el hash desde
     * la vista publica de usuarios; eso vive en las consultas, no en el esquema.
     */
    await queryRunner.query(`
      COMMENT ON COLUMN users.nfc_pin_hash IS
        'Hash argon2id del PIN opcional del login por tarjeta NFC. NULL = sin PIN.'
    `);

    /*
     * `authenticate_identity` se redefine ENTERA para sumar una columna.
     *
     * Es la funcion de la que sale TODA la autenticacion del producto: la usan
     * el login por contraseña y el login por tarjeta, y los dos leen las
     * columnas por nombre. Por eso se reescribe completa y en el mismo cambio
     * que sus consumidores: una columna agregada al final no rompe a nadie,
     * pero recrear la funcion a medias deja al producto sin login.
     *
     * Lo unico que cambia respecto de la version anterior es `nfc_pin_hash`.
     * Sigue siendo SECURITY DEFINER con search_path fijo, y el GRANT se repite
     * porque DROP FUNCTION se lleva los permisos con el.
     */
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    /*
     * Revertir tiene que devolver la funcion SIN la columna ANTES de borrarla:
     * si se cae la columna con la funcion todavia leyendola, el login entero
     * revienta al primer intento. El orden aca no es cosmetico.
     */
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
          target_user.id, target_user.password_hash, membership.tenant_id,
          tenant.display_name, tenant.status, membership.role_key, false,
          COALESCE(policy.max_failed_attempts, 5), COALESCE(policy.window_seconds, 900),
          COALESCE(policy.base_lock_seconds, 300), COALESCE(policy.max_lock_seconds, 3600)
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
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_nfc_pin_hash_format_check`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS nfc_pin_updated_at, DROP COLUMN IF EXISTS nfc_pin_hash`,
    );
  }
}
