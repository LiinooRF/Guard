import 'dotenv/config';

import { argon2id, hash } from 'argon2';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL es obligatoria para ejecutar el seed');
}

interface DemoTenant {
  tenantId: string;
  slug: string;
  displayName: string;
  users: DemoUser[];
  siteId: string;
  checkpointIds: [string, string];
  tagUids: [string, string];
  routeId: string;
  patrolId: string;
}

interface DemoUser {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'GUARDIA';
}

const ANDINA_GUARD_ID = 'a0000000-0000-4000-8000-000000000002';
const DEMO_SUPERADMIN = {
  id: 'c0000000-0000-4000-8000-000000000001',
  email: 'superadmin@demo-platform.test',
  givenName: 'Superadmin',
  familyName: 'Demo',
} as const;

const DEMO_TENANTS: DemoTenant[] = [
  {
    tenantId: 'a0000000-0000-4000-8000-000000000001',
    slug: 'demo-andina',
    displayName: 'Seguridad Andina',
    users: [
      {
        id: ANDINA_GUARD_ID,
        email: 'guardia@demo-andina.test',
        givenName: 'Guardia',
        familyName: 'Demo',
        role: 'GUARDIA',
      },
      {
        id: 'a0000000-0000-4000-8000-000000000008',
        email: 'supervisor@demo-andina.test',
        givenName: 'Supervisor',
        familyName: 'Demo',
        role: 'SUPERVISOR',
      },
      {
        id: 'a0000000-0000-4000-8000-000000000009',
        email: 'admin@demo-andina.test',
        givenName: 'Admin',
        familyName: 'Demo',
        role: 'ADMIN',
      },
    ],
    siteId: 'a0000000-0000-4000-8000-000000000003',
    checkpointIds: [
      'a0000000-0000-4000-8000-000000000004',
      'a0000000-0000-4000-8000-000000000005',
    ],
    tagUids: [
      '04A1B2C3D4E5F0',
      '04A1B2C3D4E5F1',
    ],
    routeId: 'a0000000-0000-4000-8000-000000000006',
    patrolId: 'a0000000-0000-4000-8000-000000000007',
  },
  {
    tenantId: 'b0000000-0000-4000-8000-000000000001',
    slug: 'demo-pacifico',
    displayName: 'Control Pacífico',
    users: [
      {
        id: 'b0000000-0000-4000-8000-000000000002',
        email: 'guardia@demo-pacifico.test',
        givenName: 'Guardia',
        familyName: 'Demo',
        role: 'GUARDIA',
      },
    ],
    siteId: 'b0000000-0000-4000-8000-000000000003',
    checkpointIds: [
      'b0000000-0000-4000-8000-000000000004',
      'b0000000-0000-4000-8000-000000000005',
    ],
    tagUids: [
      '04B1B2C3D4E5F0',
      '04B1B2C3D4E5F1',
    ],
    routeId: 'b0000000-0000-4000-8000-000000000006',
    patrolId: 'b0000000-0000-4000-8000-000000000007',
  },
];

async function seedTenant(
  client: Client,
  demo: DemoTenant,
  passwordHash: string,
): Promise<void> {
  await client.query('BEGIN');

  try {
    const guard = demo.users.find((user) => user.role === 'GUARDIA');
    if (!guard) throw new Error(`El tenant demo ${demo.slug} requiere un guardia`);

    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [demo.tenantId]);
    await client.query(
      `INSERT INTO tenants (id, slug, legal_name, display_name)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE
       SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [demo.tenantId, demo.slug, demo.displayName],
    );
    for (const user of demo.users) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, given_name, family_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [user.id, user.email, passwordHash, user.givenName, user.familyName],
      );
      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role_key)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [demo.tenantId, user.id, user.role],
      );
      await client.query(
        `UPDATE users SET
           email = $2,
           password_hash = $3,
           given_name = $4,
           family_name = $5,
           is_active = true,
           updated_at = now()
         WHERE id = $1`,
        [user.id, user.email, passwordHash, user.givenName, user.familyName],
      );
    }
    await client.query(
      `INSERT INTO sites (id, tenant_id, branch_name, name, address, latitude, longitude)
       VALUES ($1, $2, 'Casa matriz', 'Recinto demostración', 'Dirección ficticia 100', -33.45, -70.66)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [demo.siteId, demo.tenantId],
    );
    const supervisor = demo.users.find((user) => user.role === 'SUPERVISOR');
    if (supervisor) {
      await client.query(
        `INSERT INTO supervisor_sites (tenant_id, supervisor_id, site_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [demo.tenantId, supervisor.id, demo.siteId],
      );
    }
    await client.query(
      `INSERT INTO checkpoints
        (id, tenant_id, site_id, name, suggested_order, kind, requires_photo, instructions)
       VALUES
        ($1, $3, $4, 'Acceso principal', 1, 'acceso_critico', NULL, 'Verificar cierre del acceso'),
        ($2, $3, $4, 'Patio posterior', 2, 'normal', false, 'Revisar perímetro')
       -- Se actualizan tambien kind, requires_photo e instructions, no solo el
       -- nombre. Con el ON CONFLICT anterior, una fila sembrada por una version
       -- vieja se quedaba con su valor para siempre: en staging, 'Acceso
       -- principal' tenia requires_photo = false pese a ser 'acceso_critico'.
       --
       -- Y eso apaga justo lo que el producto promete, porque en
       -- isPhotoRequired() el override del punto GANA sobre la regla: si
       -- requiresPhoto no es null, se devuelve tal cual. NULL hereda la regla;
       -- false la pisa. La demo mostraba un acceso critico que no pedia
       -- foto, que es lo contrario de lo que hay que enseñar.
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         requires_photo = EXCLUDED.requires_photo,
         instructions = EXCLUDED.instructions`,
      [demo.checkpointIds[0], demo.checkpointIds[1], demo.tenantId, demo.siteId],
    );
    // Un punto admite UNA sola etiqueta nfc activa (`tags_checkpoint_tech_uniq`,
    // parcial WHERE is_active). Si el punto ya tiene otra —una que registro un
    // instalador, o la de una corrida anterior con otros UIDs— el INSERT de
    // abajo la viola y revienta: el `ON CONFLICT (uid)` NO cubre ese choque,
    // porque el conflicto no es por uid sino por (tenant, punto, tech). Eso
    // tumbaba el arranque entero de la API, no solo la demo.
    //
    // Se desactiva en vez de borrar: los escaneos ya hechos apuntan a la
    // etiqueta y el historial tiene que seguir resolviendo.
    await client.query(
      `UPDATE tags SET is_active = false
        WHERE tenant_id = $1 AND checkpoint_id IN ($2, $3) AND tech = 'nfc'
          AND is_active AND uid <> ALL($4::text[])`,
      [demo.tenantId, demo.checkpointIds[0], demo.checkpointIds[1], demo.tagUids],
    );
    await client.query(
      `INSERT INTO tags (tenant_id, checkpoint_id, tech, uid)
       VALUES
         ($1, $2, 'nfc', $4),
         ($1, $3, 'nfc', $5)
       ON CONFLICT (uid) WHERE is_active DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         checkpoint_id = EXCLUDED.checkpoint_id,
         tech = EXCLUDED.tech`,
      [demo.tenantId, demo.checkpointIds[0], demo.checkpointIds[1], demo.tagUids[0], demo.tagUids[1]],
    );
    await client.query(
      `INSERT INTO routes
        (id, tenant_id, site_id, name, estimated_duration_min, tolerance_min)
       VALUES ($1, $2, $3, 'Ronda nocturna demo', 30, 10)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [demo.routeId, demo.tenantId, demo.siteId],
    );
    await client.query(
      `INSERT INTO route_checkpoints
        (tenant_id, route_id, checkpoint_id, position, is_closing_point)
       VALUES ($1, $2, $3, 1, false), ($1, $2, $4, 2, true)
       ON CONFLICT DO NOTHING`,
      [demo.tenantId, demo.routeId, demo.checkpointIds[0], demo.checkpointIds[1]],
    );
    await client.query(
      `INSERT INTO patrols
        (id, tenant_id, site_id, route_id, guard_id, scheduled_start_at,
         scheduled_end_at, expected_checkpoint_ids)
       VALUES (
         $1, $2, $3, $4, $5,
         (date_trunc('day', now() AT TIME ZONE 'America/Santiago') + interval '22 hours')
           AT TIME ZONE 'America/Santiago',
         (date_trunc('day', now() AT TIME ZONE 'America/Santiago') + interval '1 day 6 hours')
           AT TIME ZONE 'America/Santiago',
         $6::jsonb
       )
       ON CONFLICT (id) DO UPDATE SET
         scheduled_start_at = EXCLUDED.scheduled_start_at,
         scheduled_end_at = EXCLUDED.scheduled_end_at,
         expected_checkpoint_ids = EXCLUDED.expected_checkpoint_ids,
         status = 'pendiente',
         started_at = NULL,
         closed_at = NULL,
         compliance_pct = NULL`,
      [
        demo.patrolId,
        demo.tenantId,
        demo.siteId,
        demo.routeId,
        guard.id,
        JSON.stringify(demo.checkpointIds),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedSuperadmin(client: Client, passwordHash: string): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, password_hash, given_name, family_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         given_name = EXCLUDED.given_name,
         family_name = EXCLUDED.family_name,
         is_active = true,
         updated_at = now()`,
      [
        DEMO_SUPERADMIN.id,
        DEMO_SUPERADMIN.email,
        passwordHash,
        DEMO_SUPERADMIN.givenName,
        DEMO_SUPERADMIN.familyName,
      ],
    );
    await client.query(
      `INSERT INTO platform_memberships (user_id, role_key)
       VALUES ($1, 'SUPERADMIN') ON CONFLICT DO NOTHING`,
      [DEMO_SUPERADMIN.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('El seed de desarrollo no puede ejecutarse en producción');
  }

  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword || demoPassword.length < 12) {
    throw new Error('DEMO_PASSWORD es obligatoria y debe tener al menos 12 caracteres');
  }
  const passwordHash = await hash(demoPassword, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const demo of DEMO_TENANTS) {
      await seedTenant(client, demo, passwordHash);
    }
    await seedSuperadmin(client, passwordHash);
    const tenantUserCount = DEMO_TENANTS.reduce((total, tenant) => total + tenant.users.length, 0);
    console.log(
      `Seed listo: ${DEMO_TENANTS.length} tenants y ${tenantUserCount + 1} usuarios demo`,
    );
  } finally {
    await client.end();
  }
}

void main();
