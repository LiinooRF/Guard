import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, type Role } from '@sentrycore/shared';

import { AuthGuard, type AuthenticatedUser } from './auth.guard';

const VALID_USER: AuthenticatedUser = {
  sub: 'a0000000-0000-4000-8000-000000000002',
  tenant_id: 'a0000000-0000-4000-8000-000000000001',
  role: 'GUARDIA',
  sid: 'session-id',
};

function context(request: Record<string, unknown> = {}): ExecutionContext {
  Object.assign(request, {
    headers: request.headers ?? {},
    method: request.method ?? 'GET',
    path: request.path ?? '/test',
  });
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function createGuard(metadata: Record<string, unknown>, payload = VALID_USER) {
  const jwt = { verifyAsync: jest.fn().mockResolvedValue(payload) } as unknown as JwtService;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => metadata[key]),
  } as unknown as Reflector;
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ active: true }]),
  } as unknown as DataSource;
  const redis = {
    exists: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(-2),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as Redis;
  return {
    guard: new AuthGuard(jwt, reflector, dataSource, redis),
    jwt,
    dataSource,
    redis,
  };
}

describe('AuthGuard', () => {
  it('permite sólo endpoints marcados explícitamente como públicos', async () => {
    const { guard } = createGuard({ 'auth:isPublic': true });
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('cierra un endpoint nuevo sin decorador incluso con sesión', async () => {
    const { guard } = createGuard({});
    await expect(
      guard.canActivate(context({ cookies: { sentrycore_access: 'valid' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('exige token para endpoints con permisos', async () => {
    const { guard } = createGuard({ 'auth:requiredPermissions': ['patrols:execute'] });
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('adjunta identidad válida cuando rol y tenant coinciden', async () => {
    const request = { headers: {}, cookies: { sentrycore_access: 'valid' } };
    const { guard } = createGuard({
      'auth:requiredPermissions': ['patrols:execute'],
      'auth:requiresTenant': true,
    });

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request).toMatchObject({ user: VALID_USER });
  });

  describe.each(ROLES)('matriz completa para %s', (role) => {
    it.each(PERMISSIONS)('%s', async (permission) => {
      const payload = { ...VALID_USER, role, tenant_id: tenantFor(role) };
      const { guard } = createGuard(
        {
          'auth:requiredPermissions': [permission],
          'auth:requiresTenant': role !== 'SUPERADMIN',
        },
        payload,
      );
      const result = guard.canActivate(context({ cookies: { sentrycore_access: 'valid' } }));

      if ((ROLE_PERMISSIONS[role] as readonly string[]).includes(permission)) {
        await expect(result).resolves.toBe(true);
      } else {
        await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
  });

  it('invalida de inmediato una sesión de tenant suspendido o usuario desactivado', async () => {
    const { guard, dataSource } = createGuard({
      'auth:requiredPermissions': ['patrols:execute'],
      'auth:requiresTenant': true,
    });
    jest.mocked(dataSource.query).mockResolvedValue([{ active: false }]);

    await expect(
      guard.canActivate(context({ cookies: { sentrycore_access: 'valid' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('invalida inmediatamente una familia de sesión revocada', async () => {
    const { guard, redis } = createGuard({
      'auth:requiredPermissions': ['patrols:execute'],
      'auth:requiresTenant': true,
    });
    jest.mocked(redis.exists).mockResolvedValue(1);

    await expect(
      guard.canActivate(context({ cookies: { sentrycore_access: 'valid' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function tenantFor(role: Role): string | null {
  return role === 'SUPERADMIN' ? null : VALID_USER.tenant_id;
}
