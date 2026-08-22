/**
 * Crea la PRIMERA cuenta de una instalacion en blanco.
 *
 * El seed de desarrollo se niega en `NODE_ENV=production` y es el unico que
 * creaba usuarios, asi que una base recien migrada quedaba sin una sola cuenta
 * con la que entrar: el panel arrancaba y no habia forma de pasar del login.
 *
 * NO pisa nada. Si el superadmin ya existe, sale sin tocar la contraseña: este
 * guion corre en CADA arranque y un redespliegue no puede devolverle la clave
 * inicial a una cuenta cuyo dueño ya la cambio.
 */
import { hash, argon2id } from 'argon2';
import { Client } from 'pg';

async function main(): Promise<void> {
  const email = (process.env.BOOTSTRAP_SUPERADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ?? '';
  if (!email || !password) {
    console.log('bootstrap: sin BOOTSTRAP_SUPERADMIN_EMAIL/PASSWORD, no hay nada que hacer');
    return;
  }
  if (!email.includes('@')) {
    throw new Error('BOOTSTRAP_SUPERADMIN_EMAIL no parece un correo');
  }
  // El mismo minimo que exige el seed de desarrollo. La cuenta que se crea aca
  // manda sobre TODOS los tenants de la instalacion.
  if (password.length < 12) {
    throw new Error('BOOTSTRAP_SUPERADMIN_PASSWORD debe tener al menos 12 caracteres');
  }

  // La credencial administrativa, NO la de la aplicacion: `users` tiene RLS
  // FORCE y el rol de la app no puede insertar ahi. Cayendo a DATABASE_URL el
  // bootstrap moria con "new row violates row-level security policy" en el
  // primer arranque de una instalacion nueva.
  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL ??
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_ADMIN_URL;
  if (!databaseUrl) {
    throw new Error(
      'El bootstrap necesita la credencial administrativa ' +
        '(DATABASE_MIGRATION_URL, MIGRATION_DATABASE_URL o DATABASE_ADMIN_URL)',
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Rotacion explicita: cambia el correo Y la contraseña del superadmin que
    // ya existe, y tira los tokens de accion pendientes. Hace falta cuando la
    // cuenta quedo con una direccion equivocada: quien controle ese buzon puede
    // pedir un reseteo de contraseña cuando quiera y quedarse con la
    // plataforma entera. Apagada por defecto.
    if (process.env.BOOTSTRAP_ROTAR === 'true') {
      const superadmin = await client.query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM users u
          JOIN platform_memberships m ON m.user_id = u.id
         WHERE m.role_key = 'SUPERADMIN'
         ORDER BY u.created_at LIMIT 1`,
      );
      const actual = superadmin.rows[0];
      if (actual) {
        const passwordHash = await hash(password, {
          type: argon2id,
          memoryCost: 65_536,
          timeCost: 3,
          parallelism: 1,
        });
        await client.query('BEGIN');
        await client.query(
          `UPDATE users SET email = $2, password_hash = $3, updated_at = now() WHERE id = $1`,
          [actual.id, email, passwordHash],
        );
        await client.query('DELETE FROM auth_action_tokens WHERE user_id = $1', [actual.id]);
        await client.query('COMMIT');
        console.log('bootstrap: superadmin rotado de %s a %s, tokens pendientes borrados',
          actual.email, email);
        return;
      }
    }

    const existentes = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = $1',
      [email],
    );
    if (existentes.rows.length > 0) {
      console.log('bootstrap: %s ya existe, no se toca', email);
      return;
    }

    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await client.query('BEGIN');
    const creado = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, given_name, family_name)
       VALUES ($1, $2, 'Superadmin', 'VoxIA')
       RETURNING id`,
      [email, passwordHash],
    );
    const id = creado.rows[0]?.id;
    if (!id) {
      throw new Error('El INSERT del superadmin no devolvio id');
    }
    await client.query(
      `INSERT INTO platform_memberships (user_id, role_key)
       VALUES ($1, 'SUPERADMIN') ON CONFLICT DO NOTHING`,
      [id],
    );
    await client.query('COMMIT');
    console.log('bootstrap: superadmin %s creado', email);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
