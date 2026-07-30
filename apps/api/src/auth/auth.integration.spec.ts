import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AuthService } from './auth.service';

const adminUrl = process.env.DATABASE_TEST_URL;
const appUrl = process.env.DATABASE_APP_TEST_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const describeAuth = adminUrl && appUrl && redisUrl ? describe : describe.skip;

describeAuth('AuthService (integración)', () => {
  let admin: Client;
  let dataSource: DataSource;
  let redis: Redis;
  let auth: AuthService;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    await Promise.all([admin.connect(), dataSource.initialize()]);
    await redis.flushdb();
    auth = new AuthService(
      dataSource,
      new JwtService({
        secret: 'secreto-de-prueba-con-mas-de-32-caracteres',
        signOptions: {
          algorithm: 'HS256',
          issuer: 'voxia-api',
          audience: 'voxia-clients',
        },
      }),
      redis,
    );
  });

  afterAll(async () => {
    await Promise.all([admin.end(), dataSource.destroy(), redis.quit()]);
  });

  it('emite JWT tenant-aware y almacena el refresh únicamente como hash', async () => {
    const result = await auth.login({
      identity: 'guardia@demo-andina.test',
      password: 'DemoGuardia2026!',
    });
    expect('requiresTenantSelection' in result).toBe(false);
    if ('requiresTenantSelection' in result) return;

    const payload = await new JwtService({
      secret: 'secreto-de-prueba-con-mas-de-32-caracteres',
    }).verifyAsync(result.accessToken, {
      algorithms: ['HS256'],
      issuer: 'voxia-api',
      audience: 'voxia-clients',
    });
    expect(payload).toMatchObject({
      sub: 'a0000000-0000-4000-8000-000000000002',
      tenant_id: 'a0000000-0000-4000-8000-000000000001',
      role: 'GUARDIA',
    });

    const refreshHash = createHash('sha256').update(result.refreshToken).digest('hex');
    const stored = await redis.get(`auth:refresh:${refreshHash}`);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(result.refreshToken);

    await auth.logout(result.refreshToken);
    expect(await redis.get(`auth:refresh:${refreshHash}`)).toBeNull();
  });

  it('responde igual para contraseña incorrecta e identidad inexistente', async () => {
    const attempts = [
      auth.login({
        identity: 'guardia@demo-andina.test',
        password: 'PasswordIncorrecta!',
      }),
      auth.login({
        identity: 'nadie@example.test',
        password: 'PasswordIncorrecta!',
      }),
    ];

    const results = await Promise.allSettled(attempts);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({
          response: { message: 'Credenciales inválidas' },
          status: 401,
        });
      }
    }
  });

  it('obliga a seleccionar tenant cuando la identidad tiene más de uno', async () => {
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role_key)
       VALUES (
         'b0000000-0000-4000-8000-000000000001',
         'a0000000-0000-4000-8000-000000000002',
         'SUPERVISOR'
       )
       ON CONFLICT DO NOTHING`,
    );

    try {
      const result = await auth.login({
        identity: 'guardia@demo-andina.test',
        password: 'DemoGuardia2026!',
      });
      expect(result).toMatchObject({
        requiresTenantSelection: true,
        tenants: expect.arrayContaining([
          expect.objectContaining({ tenantName: 'Seguridad Andina', role: 'GUARDIA' }),
          expect.objectContaining({ tenantName: 'Control Pacífico', role: 'SUPERVISOR' }),
        ]),
      });
    } finally {
      await admin.query(
        `DELETE FROM memberships
         WHERE tenant_id = 'b0000000-0000-4000-8000-000000000001'
           AND user_id = 'a0000000-0000-4000-8000-000000000002'`,
      );
    }
  });
});
