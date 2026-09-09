import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CODIGO DE INGRESO del guardia: entra con el codigo de empresa —que el
 * telefono ya recuerda— y seis digitos, sin escribir usuario ni contraseña.
 *
 * POR QUE DOS COLUMNAS Y NO UNA
 *
 * El codigo tiene que IDENTIFICAR y AUTENTICAR a la vez: cuando el guardia
 * escribe 483920, el servidor todavia no sabe quien es. Verificar con argon2
 * contra todos los guardias de la empresa es inviable —una empresa con 50
 * guardias pagaria 50 hashes lentos por intento, que es justo lo que un
 * atacante quiere—, asi que hacen falta dos piezas:
 *
 * · `login_code_lookup`: HMAC-SHA256 del codigo con una clave del SERVIDOR
 *   (`LOGIN_CODE_PEPPER`, fuera de la base). Es determinista, esta indexado y
 *   resuelve "quien es" en una busqueda. Al no vivir la clave en la base, un
 *   volcado no permite construir el lookup de un codigo y buscarlo.
 *
 * · `login_code_hash`: argon2id, la verificacion final. Redundante a proposito:
 *   si algun dia la clave del pepper se filtra, el codigo sigue sin poder
 *   leerse de la base.
 *
 * UNICO POR EMPRESA. Dos guardias con el mismo codigo harian el ingreso
 * ambiguo: el indice unico lo impide en la base y no solo en el codigo.
 *
 * LO QUE ESTO CUESTA, ESCRITO. Seis digitos son un millon de combinaciones,
 * pero los codigos validos son tantos como guardias: con 50, uno de cada 20.000
 * intentos acierta alguno. Por eso el ingreso por codigo se bloquea por
 * EMPRESA + IP y con menos tolerancia que el login normal. Decision del equipo
 * el 09-09-2026, con el riesgo sobre la mesa.
 */
export class AddLoginCodeToGuards1727301600000 implements MigrationInterface {
  name = 'AddLoginCodeToGuards1727301600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS login_code_lookup text,
        ADD COLUMN IF NOT EXISTS login_code_hash text,
        ADD COLUMN IF NOT EXISTS login_code_updated_at timestamptz
    `);

    /*
     * Nunca el codigo en claro. El CHECK lo exige por estructura y no por
     * confianza: seis digitos guardados tal cual convierten cualquier lectura
     * de `users` —un backup, un SELECT de soporte— en una llave del carril del
     * guardia.
     */
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_login_code_hash_ck
    `);
    await queryRunner.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_login_code_hash_ck
        CHECK (login_code_hash IS NULL OR login_code_hash LIKE '$argon2id$%')
    `);

    /*
     * Unico DENTRO de la empresa, no global: dos empresas distintas pueden
     * repetir codigo sin ambiguedad, porque el ingreso siempre llega con el
     * codigo de empresa.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_login_code_lookup_uq
        ON users (tenant_id, login_code_lookup)
        WHERE login_code_lookup IS NOT NULL
    `);

    /*
     * El ingreso ocurre ANTES de que exista contexto de tenant, asi que la
     * busqueda no puede pasar por RLS: va en una funcion SECURITY DEFINER, el
     * mismo mecanismo que ya usa `authenticate_identity`.
     *
     * Acota a GUARDIA en la propia funcion: el codigo corto es para el carril
     * del guardia, y que un admin pudiera entrar con seis digitos seria bajarle
     * la seguridad a la cuenta que configura las reglas.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION authenticate_login_code(
        empresa uuid,
        codigo_lookup text
      )
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
        tenant_slug text,
        login_code_hash text
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
          tenant.slug,
          target_user.login_code_hash
        FROM public.users target_user
        JOIN public.memberships membership ON membership.user_id = target_user.id
        JOIN public.tenants tenant ON tenant.id = membership.tenant_id
        LEFT JOIN public.tenant_auth_policies policy ON policy.tenant_id = tenant.id
        WHERE target_user.is_active
          AND membership.role_key = 'GUARDIA'
          AND membership.tenant_id = empresa
          AND target_user.login_code_lookup IS NOT NULL
          AND target_user.login_code_lookup = codigo_lookup
      $$
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION authenticate_login_code(uuid, text) FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION authenticate_login_code(uuid, text) TO sentrycore_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS authenticate_login_code(uuid, text)`);
    await queryRunner.query(`DROP INDEX IF EXISTS users_login_code_lookup_uq`);
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_login_code_hash_ck
    `);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS login_code_lookup,
        DROP COLUMN IF EXISTS login_code_hash,
        DROP COLUMN IF EXISTS login_code_updated_at
    `);
  }
}
