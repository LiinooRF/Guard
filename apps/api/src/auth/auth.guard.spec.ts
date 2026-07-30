import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';

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
  return { guard: new AuthGuard(jwt, reflector, dataSource), jwt, dataSource };
}

describe('AuthGuard', () => {
  it('permite sólo endpoints marcados explícitamente como públicos', async () => {
    const { guard } = createGuard({ 'auth:isPublic': true });
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('cierra un endpoint nuevo sin decorador incluso con sesión', async () => {
    const { guard } = createGuard({});
    await expect(
      guard.canActivate(context({ cookies: { voxia_access: 'valid' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('exige token para endpoints con roles', async () => {
    const { guard } = createGuard({ 'auth:requiredRoles': ['GUARDIA'] });
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('adjunta identidad válida cuando rol y tenant coinciden', async () => {
    const request = { headers: {}, cookies: { voxia_access: 'valid' } };
    const { guard } = createGuard({
      'auth:requiredRoles': ['GUARDIA'],
      'auth:requiresTenant': true,
    });

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request).toMatchObject({ user: VALID_USER });
  });

  it('devuelve 403 cuando el rol no está autorizado', async () => {
    const { guard } = createGuard({ 'auth:requiredRoles': ['ADMIN'] });
    await expect(
      guard.canActivate(context({ cookies: { voxia_access: 'valid' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invalida de inmediato una sesión de tenant suspendido o usuario desactivado', async () => {
    const { guard, dataSource } = createGuard({
      'auth:requiredRoles': ['GUARDIA'],
      'auth:requiresTenant': true,
    });
    jest.mocked(dataSource.query).mockResolvedValue([{ active: false }]);

    await expect(
      guard.canActivate(context({ cookies: { voxia_access: 'valid' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
