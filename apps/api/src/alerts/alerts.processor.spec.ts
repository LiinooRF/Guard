import type { Job } from 'bullmq';
import type { DataSource, QueryRunner } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { AlertDetectionJob } from './alerts-queue.types';
import { AlertsProcessor } from './alerts.processor';
import type { AlertsService } from './alerts.service';

function setup(detect = jest.fn().mockResolvedValue({ created: true })) {
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: { query: jest.fn().mockResolvedValue(undefined) },
  } as unknown as QueryRunner;
  const dataSource = { createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
  const tenantContext = {
    run: jest.fn((_runner, operation: () => Promise<unknown>) => operation()),
  } as unknown as TenantContextService;
  const alerts = { detectScheduled: detect } as unknown as AlertsService;
  return { processor: new AlertsProcessor(dataSource, tenantContext, alerts), runner, tenantContext };
}

const job = { data: {
  tenantId: 'tenant-1', patrolId: 'patrol-1', kind: 'atrasada',
} } as Job<AlertDetectionJob>;

describe('AlertsProcessor', () => {
  it('restaura el tenant antes de detectar y confirma la transacción', async () => {
    const { processor, runner, tenantContext } = setup();

    await expect(processor.process(job)).resolves.toEqual({ created: true });
    expect(runner.manager.query).toHaveBeenCalledWith(expect.stringContaining(
      "set_config('app.tenant_id', $1, true)"), ['tenant-1']);
    expect(tenantContext.run).toHaveBeenCalledWith(runner, expect.any(Function));
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('revierte y libera la conexión cuando falla la detección', async () => {
    const { processor, runner } = setup(jest.fn().mockRejectedValue(new Error('db caida')));

    await expect(processor.process(job)).rejects.toThrow('db caida');
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });
});
