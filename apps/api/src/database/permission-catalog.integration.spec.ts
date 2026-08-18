import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@sentrycore/shared';
import { Client } from 'pg';

const adminUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase('catálogo RBAC persistido', () => {
  let database: Client;

  beforeAll(async () => {
    database = new Client({ connectionString: adminUrl });
    await database.connect();
  });

  afterAll(async () => {
    await database.end();
  });

  it('coincide exactamente con la matriz compartida', async () => {
    const permissions = await database.query<{ key: string }>(
      `SELECT key FROM permissions ORDER BY key`,
    );
    expect(permissions.rows.map(({ key }) => key)).toEqual([...PERMISSIONS].sort());

    const mappings = await database.query<{ role_key: string; permission_key: string }>(
      `SELECT role_key, permission_key
       FROM role_permissions
       ORDER BY role_key, permission_key`,
    );
    const expected = ROLES.flatMap((role) =>
      ROLE_PERMISSIONS[role].map((permission) => ({
        role_key: role,
        permission_key: permission,
      })),
    ).sort((left, right) =>
      `${left.role_key}:${left.permission_key}`.localeCompare(
        `${right.role_key}:${right.permission_key}`,
      ),
    );

    expect(mappings.rows).toEqual(expected);
  });
});
