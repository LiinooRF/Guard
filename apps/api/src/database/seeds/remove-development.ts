import 'dotenv/config';

import { Client } from 'pg';

const DEMO_TENANT_IDS = [
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
];
const DEMO_USER_IDS = [
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000008',
  'a0000000-0000-4000-8000-000000000009',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000001',
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('La limpieza demo no puede ejecutarse en producción');
  }
  if (process.env.CONFIRM_REMOVE_DEMO !== 'true') {
    throw new Error('Define CONFIRM_REMOVE_DEMO=true para confirmar la limpieza');
  }

  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL es obligatoria para retirar los datos demo');

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Las claves compuestas del dominio usan RESTRICT para proteger operación
    // real; la limpieza explícita respeta su orden sin relajar esas garantías.
    await client.query(`DELETE FROM patrols WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM route_checkpoints WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM checkpoints WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM routes WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM supervisor_sites WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])`, [
      DEMO_TENANT_IDS,
    ]);
    await client.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [DEMO_TENANT_IDS]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [DEMO_USER_IDS]);
    await client.query('COMMIT');
    console.log('Datos demo eliminados completamente');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

void main();
