import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AuthService } from './auth.service';
import { createAuthActionToken } from './auth-action-token';
import type { MailService } from './mail.service';

const adminUrl = process.env.DATABASE_TEST_URL;
const appUrl = process.env.DATABASE_APP_TEST_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const describeAuth = adminUrl && appUrl && redisUrl ? describe : describe.skip;

describeAuth('AuthService (integración)', () => {
  let admin: Client;
  let dataSource: DataSource;
  let redis: Redis;
  let auth: AuthService;
  let mail: Pick<MailService, 'invitation' | 'passwordReset'>;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    await Promise.all([admin.connect(), dataSource.initialize()]);
    await redis.flushdb();
    mail = {
      invitation: jest.fn().mockResolvedValue(undefined),
      passwordReset: jest.fn().mockResolvedValue(undefined),
    };
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
      mail as MailService,
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

  it('rota el refresh token y vuelve inutilizable el anterior', async () => {
    const login = await auth.login({
      identity: 'guardia@demo-andina.test',
      password: 'DemoGuardia2026!',
    });
    if ('requiresTenantSelection' in login) throw new Error('Login demo ambiguo');

    const rotated = await auth.refresh(login.refreshToken);
    expect(rotated.refreshToken).not.toBe(login.refreshToken);
    await expect(auth.refresh(login.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ status: 401 });

    const rotatedHash = createHash('sha256').update(rotated.refreshToken).digest('hex');
    expect(await redis.get(`auth:refresh:${rotatedHash}`)).toBeNull();
  });

  it('explica el bloqueo sólo después de validar una credencial de tenant suspendido', async () => {
    await admin.query(
      `UPDATE tenants SET status = 'suspended'
       WHERE id = 'b0000000-0000-4000-8000-000000000001'`,
    );

    try {
      await expect(
        auth.login({
          identity: 'guardia@demo-pacifico.test',
          password: 'DemoGuardia2026!',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'TENANT_SUSPENDED',
          message: expect.stringContaining('organización está suspendida'),
        },
        status: 403,
      });

      await expect(
        auth.login({
          identity: 'guardia@demo-pacifico.test',
          password: 'PasswordIncorrecta!',
        }),
      ).rejects.toMatchObject({
        response: { message: 'Credenciales inválidas' },
        status: 401,
      });
    } finally {
      await admin.query(
        `UPDATE tenants SET status = 'active'
         WHERE id = 'b0000000-0000-4000-8000-000000000001'`,
      );
    }
  });

  it('lista dispositivos y permite revocar una sesión o todas', async () => {
    const first = await auth.login(
      {
        identity: 'guardia@demo-pacifico.test',
        password: 'DemoGuardia2026!',
      },
      'test',
      'Firefox de prueba',
    );
    const second = await auth.login(
      {
        identity: 'guardia@demo-pacifico.test',
        password: 'DemoGuardia2026!',
      },
      'test',
      'Android de prueba',
    );
    if ('requiresTenantSelection' in first || 'requiresTenantSelection' in second) {
      throw new Error('Login demo ambiguo');
    }
    const firstPayload = await new JwtService({
      secret: 'secreto-de-prueba-con-mas-de-32-caracteres',
    }).verifyAsync<{ sid: string }>(first.accessToken);
    const secondPayload = await new JwtService({
      secret: 'secreto-de-prueba-con-mas-de-32-caracteres',
    }).verifyAsync<{ sid: string }>(second.accessToken);

    const sessions = await auth.listSessions(first.user.id, firstPayload.sid);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ device: 'Firefox de prueba', current: true }),
      expect.objectContaining({ device: 'Android de prueba', current: false }),
    ]));

    await expect(auth.revokeSession(first.user.id, secondPayload.sid)).resolves.toBe(true);
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(first.refreshToken)).resolves.toBeTruthy();

    await auth.revokeAllSessions(first.user.id);
    const remaining = await auth.listSessions(first.user.id, firstPayload.sid);
    expect(remaining).toHaveLength(0);
  });

  it('bloquea por identidad aunque cambie la IP y escala bloqueos configurables', async () => {
    const identity = 'guardia@demo-pacifico.test';
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const lockKey = `auth:login-lock:identity:${identityHash}`;
    await admin.query(`
      INSERT INTO tenant_auth_policies (
        tenant_id, max_failed_attempts, window_seconds,
        base_lock_seconds, max_lock_seconds
      ) VALUES (
        'b0000000-0000-4000-8000-000000000001', 3, 60, 60, 600
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        max_failed_attempts = EXCLUDED.max_failed_attempts,
        window_seconds = EXCLUDED.window_seconds,
        base_lock_seconds = EXCLUDED.base_lock_seconds,
        max_lock_seconds = EXCLUDED.max_lock_seconds
    `);
    await redis.del(
      lockKey,
      `auth:login-attempts:identity:${identityHash}`,
      `auth:login-lock-level:${identityHash}`,
    );

    const failFromChangingIps = async (offset: number) =>
      auth.login(
        { identity, password: 'PasswordIncorrecta!' },
        `192.0.2.${offset}`,
      );

    try {
      await expect(failFromChangingIps(1)).rejects.toMatchObject({ status: 401 });
      await expect(failFromChangingIps(2)).rejects.toMatchObject({ status: 401 });
      await expect(failFromChangingIps(3)).rejects.toMatchObject({ status: 429 });
      const firstLockTtl = await redis.ttl(lockKey);
      await expect(
        auth.login({ identity, password: 'DemoGuardia2026!' }, '198.51.100.10'),
      ).rejects.toMatchObject({ status: 429 });

      await redis.del(lockKey);
      await expect(failFromChangingIps(4)).rejects.toMatchObject({ status: 401 });
      await expect(failFromChangingIps(5)).rejects.toMatchObject({ status: 401 });
      await expect(failFromChangingIps(6)).rejects.toMatchObject({ status: 429 });
      const secondLockTtl = await redis.ttl(lockKey);
      expect(secondLockTtl).toBeGreaterThan(firstLockTtl);

      const events = await admin.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM security_events
        WHERE tenant_id = 'b0000000-0000-4000-8000-000000000001'
          AND identity_hash = $1
      `, [identityHash]);
      expect(Number(events.rows[0]?.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await redis.del(
        lockKey,
        `auth:login-attempts:identity:${identityHash}`,
        `auth:login-lock-level:${identityHash}`,
      );
      await admin.query(`DELETE FROM security_events WHERE identity_hash = $1`, [identityHash]);
      await admin.query(`
        UPDATE tenant_auth_policies
        SET max_failed_attempts = 5,
            window_seconds = 900,
            base_lock_seconds = 300,
            max_lock_seconds = 3600
        WHERE tenant_id = 'b0000000-0000-4000-8000-000000000001'
      `);
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

  it('consume invitaciones una sola vez y nunca guarda el token en claro', async () => {
    const userId = 'a0000000-0000-4000-8000-000000000002';
    const original = await admin.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
    );
    const action = createAuthActionToken(60_000);

    try {
      await admin.query(
        `SELECT issue_auth_action_token($1, $2, 'invitation', $3, $4)`,
        [
          userId,
          'a0000000-0000-4000-8000-000000000001',
          action.tokenHash,
          action.expiresAt,
        ],
      );
      const stored = await admin.query<{ token_hash: string }>(
        `SELECT token_hash FROM auth_action_tokens WHERE user_id = $1 AND purpose = 'invitation'`,
        [userId],
      );
      expect(stored.rows[0]?.token_hash).toBe(action.tokenHash);
      expect(stored.rows[0]?.token_hash).not.toBe(action.token);

      await expect(
        auth.completeInvitation({ token: action.token, password: 'NuevaClaveSegura2026!' }),
      ).resolves.toBeUndefined();
      await expect(
        auth.completeInvitation({ token: action.token, password: 'OtraClaveSegura2026!' }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await admin.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
        original.rows[0]!.password_hash,
        userId,
      ]);
      await admin.query(`DELETE FROM auth_action_tokens WHERE user_id = $1`, [userId]);
    }
  });

  it('responde igual al recuperar un correo existente o inexistente', async () => {
    await auth.requestPasswordReset('guardia@demo-andina.test', '198.51.100.20');
    await auth.requestPasswordReset('inexistente@example.test', '198.51.100.21');

    expect(mail.passwordReset).toHaveBeenCalledTimes(1);
    expect(mail.passwordReset).toHaveBeenCalledWith(
      'guardia@demo-andina.test',
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      'a0000000-0000-4000-8000-000000000001',
      expect.stringMatching(/^password-reset:[a-f0-9]{64}$/),
    );
    await admin.query(
      `DELETE FROM auth_action_tokens
       WHERE user_id = 'a0000000-0000-4000-8000-000000000002'
         AND purpose = 'password_reset'`,
    );
  });
});
