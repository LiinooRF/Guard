import { UnauthorizedException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of } from 'rxjs';
import type { DataSource, QueryRunner } from 'typeorm';

import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

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

describe('TenantContextInterceptor', () => {
  it('deniega un request sin tenant autenticado', () => {
    const interceptor = new TenantContextInterceptor(
      {} as DataSource,
      new TenantContextService(),
      { getAllAndOverride: () => false } as unknown as Reflector,
    );

    expect(() => interceptor.intercept(executionContext(), { handle: () => of(null) })).toThrow(
      UnauthorizedException,
    );
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
    );
    const tenantIds = Array.from(
      { length: 50 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    );

    const results = await Promise.all(
      tenantIds.map((tenantId) => {
        const next: CallHandler = {
          handle: () =>
            defer(async () => {
              await new Promise((resolve) => setImmediate(resolve));
              return (context.manager as unknown as { tenantId: string }).tenantId;
            }),
        };
        return lastValueFrom(interceptor.intercept(executionContext(tenantId), next));
      }),
    );

    expect(results).toEqual(tenantIds);
    expect(runners).toHaveLength(50);
    for (const runner of runners) {
      expect(runner.connect).toHaveBeenCalledTimes(1);
      expect(runner.startTransaction).toHaveBeenCalledTimes(1);
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalledTimes(1);
    }
  });
});
