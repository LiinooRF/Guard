import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { TenantDataService } from './tenant-data.service';

const ACTOR = 'f0000000-0000-4000-8000-000000000009';
const TENANT = 'a0000000-0000-4000-8000-000000000001';

/**
 * Regresion de la forma que devuelve el driver: un UPDATE devuelve
 * **[filas, rowCount]**, no filas. `rows[0]` era entonces el ARREGLO de filas
 * —truthy aunque venga vacio— y `toDeletion()` lo mapeaba campo por campo a
 * undefined: el 404 no salia nunca y el comprobante del purge salia vacio.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

const FILA_BORRADO = {
  id: 'del-1',
  target_tenant_id: TENANT,
  requested_by: ACTOR,
  requested_at: new Date('2026-07-01T12:00:00.000Z'),
  purge_after: new Date('2026-07-31T12:00:00.000Z'),
  status: 'cancelado' as const,
  reason: 'la empresa renovo el contrato',
  executed_at: null,
};

const conManager = (manager: { query: jest.Mock }) =>
  new TenantDataService({
    transaction: (operation: (m: unknown) => Promise<unknown>) => operation(manager),
  } as unknown as DataSource);

describe('TenantDataService — forma real del driver', () => {
  it('cancelar un borrado que no existe es 404, no un 200 con todo en undefined', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config del actor
      .mockResolvedValueOnce(comoDriver([])); // UPDATE sin filas

    await expect(conManager(manager).cancelDeletion(ACTOR, TENANT))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('cancelar un borrado programado devuelve la solicitud, no un objeto vacio', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(comoDriver([FILA_BORRADO]));

    await expect(conManager(manager).cancelDeletion(ACTOR, TENANT)).resolves.toMatchObject({
      id: 'del-1',
      tenantId: TENANT,
      status: 'cancelado',
      reason: 'la empresa renovo el contrato',
    });
  });

  it('el comprobante del purge lleva id, fecha y estado de verdad', async () => {
    // Es la unica prueba de que el borrado definitivo se ejecuto y cuando.
    const ejecutado = {
      ...FILA_BORRADO,
      status: 'ejecutado' as const,
      executed_at: new Date('2026-08-01T09:00:00.000Z'),
    };
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config del actor
      .mockResolvedValueOnce([
        { id: 'del-1', purge_after: FILA_BORRADO.purge_after, expired: true },
      ]) // solicitud vigente y vencida
      .mockResolvedValueOnce([{ table_name: 'sites' }]) // information_schema
      .mockResolvedValueOnce([]) // platform_purge_tenant
      .mockResolvedValueOnce([{ remaining: '0' }]) // sin filas huerfanas
      .mockResolvedValueOnce(comoDriver([ejecutado])); // UPDATE final

    await expect(conManager(manager).executeDeletion(ACTOR, TENANT)).resolves.toMatchObject({
      id: 'del-1',
      status: 'ejecutado',
      executedAt: ejecutado.executed_at,
    });
  });
});
