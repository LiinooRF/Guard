import 'dotenv/config';

import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL es obligatoria para ejecutar el seed');
}

interface DemoTenant {
  tenantId: string;
  slug: string;
  displayName: string;
  userId: string;
  email: string;
  siteId: string;
  checkpointIds: [string, string];
  routeId: string;
  patrolId: string;
}

const DEMO_TENANTS: DemoTenant[] = [
  {
    tenantId: 'a0000000-0000-4000-8000-000000000001',
    slug: 'demo-andina',
    displayName: 'Seguridad Andina',
    userId: 'a0000000-0000-4000-8000-000000000002',
    email: 'guardia@demo-andina.test',
    siteId: 'a0000000-0000-4000-8000-000000000003',
    checkpointIds: [
      'a0000000-0000-4000-8000-000000000004',
      'a0000000-0000-4000-8000-000000000005',
    ],
    routeId: 'a0000000-0000-4000-8000-000000000006',
    patrolId: 'a0000000-0000-4000-8000-000000000007',
  },
  {
    tenantId: 'b0000000-0000-4000-8000-000000000001',
    slug: 'demo-pacifico',
    displayName: 'Control Pacífico',
    userId: 'b0000000-0000-4000-8000-000000000002',
    email: 'guardia@demo-pacifico.test',
    siteId: 'b0000000-0000-4000-8000-000000000003',
    checkpointIds: [
      'b0000000-0000-4000-8000-000000000004',
      'b0000000-0000-4000-8000-000000000005',
    ],
    routeId: 'b0000000-0000-4000-8000-000000000006',
    patrolId: 'b0000000-0000-4000-8000-000000000007',
  },
];

async function seedTenant(client: Client, demo: DemoTenant): Promise<void> {
  await client.query('BEGIN');

  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [demo.tenantId]);
    await client.query(
      `INSERT INTO tenants (id, slug, legal_name, display_name)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE
       SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [demo.tenantId, demo.slug, demo.displayName],
    );
    const existingMembership = await client.query(
      `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [demo.tenantId, demo.userId],
    );
    if (existingMembership.rowCount === 0) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, given_name, family_name)
         VALUES ($1, $2, 'LOGIN_DESHABILITADO_SEED', 'Guardia', 'Demo')`,
        [demo.userId, demo.email],
      );
    }
    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role_key)
       VALUES ($1, $2, 'GUARDIA') ON CONFLICT DO NOTHING`,
      [demo.tenantId, demo.userId],
    );
    await client.query(
      `INSERT INTO sites (id, tenant_id, branch_name, name, address, latitude, longitude)
       VALUES ($1, $2, 'Casa matriz', 'Recinto demostración', 'Dirección ficticia 100', -33.45, -70.66)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [demo.siteId, demo.tenantId],
    );
    await client.query(
      `INSERT INTO checkpoints
        (id, tenant_id, site_id, name, suggested_order, kind, requires_photo, instructions)
       VALUES
        ($1, $3, $4, 'Acceso principal', 1, 'acceso_critico', NULL, 'Verificar cierre del acceso'),
        ($2, $3, $4, 'Patio posterior', 2, 'normal', false, 'Revisar perímetro')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [demo.checkpointIds[0], demo.checkpointIds[1], demo.tenantId, demo.siteId],
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
       VALUES ($1, $2, $3, $4, $5, date_trunc('day', now()) + interval '22 hours',
         date_trunc('day', now()) + interval '1 day 6 hours', $6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        demo.patrolId,
        demo.tenantId,
        demo.siteId,
        demo.routeId,
        demo.userId,
        JSON.stringify(demo.checkpointIds),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const demo of DEMO_TENANTS) {
      await seedTenant(client, demo);
    }
    console.log(`Seed listo: ${DEMO_TENANTS.length} tenants demo aislados`);
  } finally {
    await client.end();
  }
}

void main();
