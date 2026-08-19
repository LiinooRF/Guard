import { UnauthorizedException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of } from 'rxjs';
import type { DataSource, QueryRunner } from 'typeorm';

import { TenantContextInterceptor } from './tenant-context.interceptor';
import { SupportAccessService } from '../../platform-data/support-access.service';
import { TenantContextService } from './tenant-context.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPORT_ACCESS_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function executionContext(tenantId?: string): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({
        user: tenantId ? { sub: USER_ID, tenant_id: tenantId } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

function supportExecutionContext(): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({
        user: { sub: USER_ID },
        headers: { 'x-support-access-id': SUPPORT_ACCESS_ID },
      }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * Sin acceso de soporte: resolve devuelve null, que es el camino normal de
 * cualquier request con tenant en la sesion.
 */
const sinSoporte = () =>
  ({ resolve: jest.fn().mockResolvedValue(null) }) as unknown as SupportAccessService;

describe('TenantContextInterceptor', () => {
  it('deniega un request sin tenant autenticado', async () => {
    const interceptor = new TenantContextInterceptor(
      {} as DataSource,
      new TenantContextService(),
      { getAllAndOverride: () => false } as unknown as Reflector,
      sinSoporte(),
    );

    await expect(
      interceptor.intercept(executionContext(), { handle: () => of(null) }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('mantiene aislados 50 requests concurrentes y libera sus conexiones', async () => {
    const context = new TenantContextService();
    const runners: Array<{
      tenantId?: string;
      connect: jest.Mock;
      startTransaction: jest.Mock;
      commitTransaction: jest.Mock;
      rollbackTransaction: jest.Mock;
      release: jest.Mock;
    }> = [];

    const dataSource = {
      createQueryRunner: () => {
        const state = {
          tenantId: undefined as string | undefined,
          connect: jest.fn().mockResolvedValue(undefined),
          startTransaction: jest.fn().mockResolvedValue(undefined),
          commitTransaction: jest.fn().mockResolvedValue(undefined),
          rollbackTransaction: jest.fn().mockResolvedValue(undefined),
          release: jest.fn().mockResolvedValue(undefined),
        };
        const runner = {
          ...state,
          manager: state,
          query: jest.fn().mockImplementation((_sql: string, values: string[]) => {
            state.tenantId = values[0];
          }),
        };
        runners.push(state);
        return runner as unknown as QueryRunner;
      },
    } as unknown as DataSource;

    const interceptor = new TenantContextInterceptor(
      dataSource,
      context,
      { getAllAndOverride: () => false } as unknown as Reflector,
      sinSoporte(),
    );
    const tenantIds = Array.from(
      { length: 50 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    );

    const results = await Promise.all(
      tenantIds.map(async (tenantId) => {
        const next: CallHandler = {
          handle: () =>
            defer(async () => {
              await new Promise((resolve) => setImmediate(resolve));
              return {
                managerTenant: (context.manager as unknown as { tenantId: string }).tenantId,
                contextTenant: context.tenantId,
              };
            }),
        };
        return lastValueFrom(await interceptor.intercept(executionContext(tenantId), next));
      }),
    );

    expect(results).toEqual(
      tenantIds.map((tenantId) => ({ managerTenant: tenantId, contextTenant: tenantId })),
    );
    expect(runners).toHaveLength(50);
    for (const runner of runners) {
      expect(runner.connect).toHaveBeenCalledTimes(1);
      expect(runner.startTransaction).toHaveBeenCalledTimes(1);
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalledTimes(1);
    }
  });

  it('ejecuta invalidaciones registradas solo despues del commit', async () => {
    const context = new TenantContextService();
    const order: string[] = [];
    const runner = {
      manager: {},
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockImplementation(async () => {
        order.push('commit');
      }),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockImplementation(async () => {
        order.push('release');
      }),
    } as unknown as QueryRunner;
    const interceptor = new TenantContextInterceptor(
      { createQueryRunner: () => runner } as unknown as DataSource,
      context,
      { getAllAndOverride: () => false } as unknown as Reflector,
      sinSoporte(),
    );
    const next: CallHandler = {
      handle: () =>
        defer(async () => {
          order.push('handler');
          context.afterCommit(() => {
            order.push('after-commit');
          });
          return null;
        }),
    };

    await lastValueFrom(await interceptor.intercept(executionContext(TENANT_A), next));

    expect(order).toEqual(['handler', 'commit', 'after-commit', 'release']);
  });

  it('soporte auditado mantiene cache fail-safe sin tenant en ALS', async () => {
    const context = new TenantContextService();
    const runner = {
      manager: {},
      connect: jest.fn(),
      startTransaction: jest.fn(),
      query: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    } as unknown as QueryRunner;
    const support = {
      resolve: jest.fn().mockResolvedValue(TENANT_A),
    } as unknown as SupportAccessService;
    const interceptor = new TenantContextInterceptor(
      { createQueryRunner: () => runner } as unknown as DataSource,
      context,
      { getAllAndOverride: () => false } as unknown as Reflector,
      support,
    );

    const result = await lastValueFrom(
      await interceptor.intercept(supportExecutionContext(), {
        handle: () => of(context.tenantId),
      }),
    );

    expect(result).toBeNull();
    expect(support.resolve).toHaveBeenCalledWith(SUPPORT_ACCESS_ID, USER_ID);
  });
});
