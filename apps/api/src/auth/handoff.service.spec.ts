import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AuthService } from './auth.service';
import type { AuthenticatedSession } from './auth.types';
import { HandoffService, HANDOFF_TTL_SECONDS, type HandoffClaims } from './handoff.service';
import type { MailService } from './mail.service';

const SECRET = 'secreto-de-prueba-con-mas-de-32-caracteres';
const FAMILY_ID = 'c0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000002';
const TENANT_ID = 'a0000000-0000-4000-8000-000000000001';

const CLAIMS: HandoffClaims = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  role: 'GUARDIA',
  familyId: FAMILY_ID,
};

const SESSION: AuthenticatedSession = {
  accessToken: 'jwt-de-prueba',
  refreshToken: 'refresh-de-prueba',
  expiresIn: 900,
  user: { id: USER_ID, tenantId: TENANT_ID, tenantName: null, role: 'GUARDIA' },
};

/**
 * Redis en memoria que reproduce los dos scripts Lua del servicio: emitir usa
 * dos claves (token y puntero por familia), canjear usa una. Con reloj propio
 * para poder pasar los 60 segundos sin esperarlos.
 */
function fakeRedis(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const read = (key: string): string | null => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= clock.now) {
      store.delete(key);
      return null;
    }
    return entry.value;
  };
  const write = (key: string, value: string, ttlSeconds: number): void => {
    store.set(key, { value, expiresAt: clock.now + ttlSeconds * 1000 });
  };

  return {
    status: 'ready',
    connect: jest.fn(),
    eval: jest.fn(async (_script: string, numKeys: number, ...args: unknown[]) => {
      if (numKeys === 2) {
        const [tokenKey, familyKey, claims, ttl, tokenHash] = args as [
          string,
          string,
          string,
          number,
          string,
        ];
        const previous = read(familyKey);
        if (previous) store.delete(`auth:handoff:${previous}`);
        write(tokenKey, claims, ttl);
        write(familyKey, tokenHash, ttl);
        return 1;
      }
      const [tokenKey] = args as [string];
      const stored = read(tokenKey);
      if (stored === null) return '';
      store.delete(tokenKey);
      return stored;
    }),
    snapshot: () => [...store.entries()].map(([key, entry]) => `${key}=${entry.value}`),
  };
}

function buildService(clock = { now: Date.now() }) {
  const redis = fakeRedis(clock);
  const auth = { issueForExistingSession: jest.fn().mockResolvedValue(SESSION) };
  const service = new HandoffService(
    redis as unknown as Redis,
    auth as unknown as AuthService,
  );
  return { service, redis, auth, clock };
}

describe('HandoffService', () => {
  it('guarda el token hasheado y nunca en claro', async () => {
    const { service, redis } = buildService();

    const ticket = await service.issue(CLAIMS);

    const tokenHash = createHash('sha256').update(ticket.token).digest('hex');
    expect(redis.snapshot()).toEqual(
      expect.arrayContaining([`auth:handoff:${tokenHash}=${JSON.stringify(CLAIMS)}`]),
    );
    for (const entry of redis.snapshot()) {
      expect(entry).not.toContain(ticket.token);
    }
    expect(ticket.expiresIn).toBe(HANDOFF_TTL_SECONDS);
  });

  it('se canjea una sola vez: el segundo intento responde 401', async () => {
    const { service, auth } = buildService();
    const ticket = await service.issue(CLAIMS);

    await expect(service.redeem(ticket.token)).resolves.toBe(SESSION);
    await expect(service.redeem(ticket.token)).rejects.toMatchObject({ status: 401 });
    expect(auth.issueForExistingSession).toHaveBeenCalledTimes(1);
  });

  it('dos canjes simultáneos no pueden ganar los dos', async () => {
    const { service, auth } = buildService();
    const ticket = await service.issue(CLAIMS);

    const results = await Promise.allSettled([
      service.redeem(ticket.token),
      service.redeem(ticket.token),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(auth.issueForExistingSession).toHaveBeenCalledTimes(1);
  });

  it('vence a los 60 segundos aunque nadie lo haya usado', async () => {
    const clock = { now: Date.now() };
    const { service } = buildService(clock);
    const ticket = await service.issue(CLAIMS);

    clock.now += (HANDOFF_TTL_SECONDS - 1) * 1000;
    await expect(service.redeem(ticket.token)).resolves.toBe(SESSION);

    const segundo = await service.issue(CLAIMS);
    clock.now += HANDOFF_TTL_SECONDS * 1000;
    await expect(service.redeem(segundo.token)).rejects.toMatchObject({ status: 401 });
  });

  it('emitir uno nuevo invalida el anterior de la misma sesión', async () => {
    const { service } = buildService();
    const primero = await service.issue(CLAIMS);
    const segundo = await service.issue(CLAIMS);

    await expect(service.redeem(primero.token)).rejects.toMatchObject({ status: 401 });
    await expect(service.redeem(segundo.token)).resolves.toBe(SESSION);
  });

  it('canjea contra el usuario y la familia que pidieron el token, no otros', async () => {
    const { service, auth } = buildService();
    const ticket = await service.issue(CLAIMS);

    await service.redeem(ticket.token);

    expect(auth.issueForExistingSession).toHaveBeenCalledWith(CLAIMS);
  });

  it('un token con formato válido pero desconocido responde 401', async () => {
    const { service, auth } = buildService();

    await expect(service.redeem('a'.repeat(43))).rejects.toMatchObject({ status: 401 });
    expect(auth.issueForExistingSession).not.toHaveBeenCalled();
  });
});

describe('AuthService.issueForExistingSession', () => {
  const storedSession = {
    familyId: FAMILY_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    role: 'GUARDIA',
    device: 'SentryCoreAndroid/0.1',
    createdAt: '2026-08-01T10:00:00.000Z',
    lastUsedAt: '2026-08-01T10:00:00.000Z',
  };

  function buildAuth(session: unknown) {
    const redis = {
      status: 'ready',
      connect: jest.fn(),
      get: jest.fn().mockResolvedValue(session === null ? null : JSON.stringify(session)),
      eval: jest.fn().mockResolvedValue(1),
    };
    const jwt = new JwtService({
      secret: SECRET,
      signOptions: { algorithm: 'HS256', issuer: 'sentrycore-api', audience: 'sentrycore-clients' },
    });
    const auth = new AuthService(
      {} as DataSource,
      jwt,
      redis as unknown as Redis,
      {} as MailService,
    );
    return { auth, redis, jwt };
  }

  it('reemite dentro de la MISMA familia que el shell', async () => {
    const { auth, jwt } = buildAuth(storedSession);

    const session = await auth.issueForExistingSession(CLAIMS);

    const payload = await jwt.verifyAsync<{ sid: string; sub: string }>(session.accessToken);
    expect(payload.sid).toBe(FAMILY_ID);
    expect(payload.sub).toBe(USER_ID);
    expect(session.refreshToken).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{64}$/));
  });

  it('falla cerrado si la sesión ya no existe en Redis', async () => {
    const { auth } = buildAuth(null);
    await expect(auth.issueForExistingSession(CLAIMS)).rejects.toMatchObject({ status: 401 });
  });

  it('rechaza cuando la sesión guardada es de otro usuario', async () => {
    const { auth } = buildAuth({
      ...storedSession,
      userId: 'a0000000-0000-4000-8000-000000000999',
    });
    await expect(auth.issueForExistingSession(CLAIMS)).rejects.toMatchObject({ status: 401 });
  });

  it('rechaza cuando el tenant o el rol no coinciden con lo guardado', async () => {
    const { auth } = buildAuth({ ...storedSession, role: 'ADMIN' });
    await expect(auth.issueForExistingSession(CLAIMS)).rejects.toMatchObject({ status: 401 });

    const otroTenant = buildAuth({ ...storedSession, tenantId: null });
    await expect(otroTenant.auth.issueForExistingSession(CLAIMS)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('no emite nada si la familia fue revocada', async () => {
    const { auth, redis } = buildAuth(storedSession);
    redis.eval.mockResolvedValue(0);

    await expect(auth.issueForExistingSession(CLAIMS)).rejects.toMatchObject({ status: 401 });
  });
});
