import type { QueryRunner } from 'typeorm';

import { TenantContextService } from './tenant-context.service';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const runner = (marker = 'runner') =>
  ({ manager: { marker } }) as unknown as QueryRunner;

describe('TenantContextService', () => {
  it('fuera de una transaccion no inventa tenant ni manager', () => {
    const context = new TenantContextService();

    expect(context.tenantId).toBeNull();
    expect(() => context.manager).toThrow(
      'No existe una transaccion asociada al contexto tenant actual',
    );
  });

  it('mantiene tenant y manager aislados entre ejecuciones concurrentes', async () => {
    const context = new TenantContextService();
    const runnerA = runner('a');
    const runnerB = runner('b');

    const [a, b] = await Promise.all([
      context.run(runnerA, TENANT_A, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return {
          tenantId: context.tenantId,
          marker: (context.manager as unknown as { marker: string }).marker,
        };
      }),
      context.run(runnerB, TENANT_B, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return {
          tenantId: context.tenantId,
          marker: (context.manager as unknown as { marker: string }).marker,
        };
      }),
    ]);

    expect(a).toEqual({ tenantId: TENANT_A, marker: 'a' });
    expect(b).toEqual({ tenantId: TENANT_B, marker: 'b' });
    expect(context.tenantId).toBeNull();
  });

  it('sin identidad autenticada conserva manager pero deshabilita namespace de cache', async () => {
    const context = new TenantContextService();

    await expect(
      context.run(runner(), async () => ({
        tenantId: context.tenantId,
        hasManager: Boolean(context.manager),
      })),
    ).resolves.toEqual({ tenantId: null, hasManager: true });
  });

  it('rechaza una identidad no UUID antes de ejecutar la operacion', async () => {
    const context = new TenantContextService();
    const operation = jest.fn().mockResolvedValue(undefined);

    expect(() => context.run(runner(), 'tenant-del-cliente', operation)).toThrow(
      'El tenant autenticado del contexto no es un UUID valido',
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('ejecuta hooks solo despues de confirmar y una sola vez', async () => {
    const context = new TenantContextService();
    const queryRunner = runner();
    const events: string[] = [];

    await context.run(queryRunner, TENANT_A, async () => {
      expect(
        context.afterCommit(() => {
          events.push('invalidated');
        }),
      ).toBe(true);
      events.push('operation');
    });
    expect(events).toEqual(['operation']);

    events.push('commit');
    await context.transactionCommitted(queryRunner);
    await context.transactionCommitted(queryRunner);

    expect(events).toEqual(['operation', 'commit', 'invalidated']);
  });

  it('un rollback descarta hooks pendientes', async () => {
    const context = new TenantContextService();
    const queryRunner = runner();
    const callback = jest.fn();

    await context.run(queryRunner, TENANT_A, async () => {
      context.afterCommit(callback);
    });
    context.transactionRolledBack(queryRunner);
    await context.transactionCommitted(queryRunner);

    expect(callback).not.toHaveBeenCalled();
  });
});
