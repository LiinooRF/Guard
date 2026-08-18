import { DataSource } from 'typeorm';

/**
 * Que el rol de la aplicacion NO pueda, comprobado contra PostgreSQL de verdad.
 *
 * `privilegios.spec.ts` lee las migraciones y compara intencion con efecto; es
 * barato y corre siempre. Pero lee texto. Esto abre una conexion con
 * `sentrycore_app` (sin BYPASSRLS) y le pide justamente lo que no debe poder hacer.
 *
 * Existe porque la falla anterior era invisible desde el codigo: la aplicacion
 * nunca hacia `UPDATE platform_rules`, asi que ningun test lo tocaba, y el
 * permiso de mas se quedo ahi por meses. Lo que hay que probar no es lo que el
 * codigo hace, es lo que el rol podria hacer si alguien lo escribiera.
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

/** 42501 = insufficient_privilege. */
const SIN_PRIVILEGIO = '42501';

describeDatabase('privilegios efectivos de sentrycore_app', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /** Corre la sentencia y devuelve el SQLSTATE, o null si no fallo. */
  async function codigoDeError(sql: string): Promise<string | null> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(sql);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'sin-codigo';
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it.each([
    // Se escribe solo por set_platform_rules(), que empieza con
    // assert_platform_superadmin(). Con UPDATE directo esa comprobacion sobra.
    ["UPDATE platform_rules SET overrides = '{}'::jsonb", 'reglas de plataforma'],
    // Acuñar un token de recuperacion sin pasar por issue_auth_action_token().
    [
      `INSERT INTO auth_action_tokens (tenant_id, user_id, purpose, token_hash, expires_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'password_reset', 'x', now() + interval '1 h')`,
      'token de accion de autenticacion',
    ],
    // El texto de un aviso ya publicado es prueba: no se reescribe.
    ["UPDATE consent_policies SET body = 'reescrito'", 'texto del aviso de GPS'],
    // Borrar taparia quien pidio que.
    ['DELETE FROM tenant_deletions', 'solicitudes de borrado de tenant'],
    ['DELETE FROM tenant_auth_policies', 'politicas de acceso del tenant'],
  ])('el rol de la aplicacion no puede escribir %s (%s)', async (sql) => {
    expect(await codigoDeError(sql)).toBe(SIN_PRIVILEGIO);
  });

  it('pero si puede retirar un aviso, que es lo unico que cambia despues de publicarlo', async () => {
    // El GRANT por columna tiene que seguir vivo: si el REVOKE se pasara de
    // largo, publicar un aviso nuevo dejaria de poder retirar el anterior y
    // chocaria con el indice unico de un solo vigente por empresa.
    expect(await codigoDeError('UPDATE consent_policies SET retired_at = now()')).not.toBe(
      SIN_PRIVILEGIO,
    );
  });

  it.each(['field_events', 'scan_photos', 'event_photos', 'audit_log'])(
    '%s sigue siendo append-only',
    async (tabla) => {
      expect(await codigoDeError(`DELETE FROM ${tabla}`)).toBe(SIN_PRIVILEGIO);
    },
  );
});
