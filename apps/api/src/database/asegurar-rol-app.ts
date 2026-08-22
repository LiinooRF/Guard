/**
 * Garantiza el rol de aplicacion ANTES de migrar.
 *
 * El rol lo creaba solo `docker/postgres/init/01-app-role.sh`, que unicamente
 * corre cuando el directorio de datos nace vacio. Una instalacion cuyo volumen
 * ya existe —o que se configuro con otro DATABASE_APP_USER— se queda sin el, y
 * las migraciones mueren con `role "sentrycore_app" does not exist` a mitad de
 * camino: 53 migraciones nombran ese rol en sus GRANT.
 *
 * Se replican las MISMAS propiedades que el script de init, incluida la
 * verificacion de NOBYPASSRLS: un rol de aplicacion que pueda saltarse RLS
 * anula el aislamiento entre empresas, y eso no puede depender de por que via
 * se creo el rol.
 */
import { Client } from 'pg';

function usuarioDe(url: string): string {
  const usuario = new URL(url).username;
  if (!usuario) {
    throw new Error('DATABASE_URL no trae usuario: no se puede saber que rol asegurar');
  }
  return decodeURIComponent(usuario);
}

async function main(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl =
    process.env.DATABASE_MIGRATION_URL ??
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) {
    console.log('rol-app: sin DATABASE_URL o credencial administrativa, no hay nada que asegurar');
    return;
  }

  const rol = usuarioDe(appUrl);
  const clave = decodeURIComponent(new URL(appUrl).password);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existe = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [rol]);
    if (existe.rowCount === 0) {
      // format() escapa el identificador y la contraseña: el nombre del rol
      // viene de una variable de entorno y no se concatena a mano.
      await client.query(
        `SELECT format(
           'CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE',
           $1::text, $2::text)`,
        [rol, clave],
      ).then((r) => client.query((r.rows[0] as { format: string }).format));
      console.log('rol-app: rol %s creado', rol);
    }

    await client.query(`GRANT USAGE ON SCHEMA public TO ${escapar(rol)}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${escapar(rol)}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${escapar(rol)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT USAGE, SELECT ON SEQUENCES TO ${escapar(rol)}`,
    );

    const bypass = await client.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      [rol],
    );
    if (bypass.rows[0]?.rolbypassrls !== false) {
      throw new Error(`el rol ${rol} tiene BYPASSRLS: RLS no protegeria nada`);
    }
    console.log('rol-app: %s listo, sin BYPASSRLS', rol);
  } finally {
    await client.end();
  }
}

/** Comilla doble un identificador, como hace `quote_ident` de PostgreSQL. */
function escapar(identificador: string): string {
  return `"${identificador.replace(/"/g, '""')}"`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
