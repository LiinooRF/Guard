import type { DataSource } from 'typeorm';

import { DEFAULT_RETENTION_DAYS, TenantDataService } from './tenant-data.service';

const ACTOR = 'f0000000-0000-4000-8000-000000000009';
const TENANT = 'a0000000-0000-4000-8000-000000000001';

const conManager = (manager: { query: jest.Mock }) =>
  new TenantDataService({
    transaction: (operation: (m: unknown) => Promise<unknown>) => operation(manager),
  } as unknown as DataSource);

const sqlEjecutado = (manager: { query: jest.Mock }): string[] =>
  manager.query.mock.calls.map((llamada) => String(llamada[0]));

describe('TenantDataService.exportTenant', () => {
  it('descubre las tablas dinamicamente y vuelca cada una con su conteo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config del actor
      .mockResolvedValueOnce([
        { id: TENANT, slug: 'empresa-demo', display_name: 'Empresa Demo', legal_name: 'Empresa Demo SpA', status: 'active' },
      ]) // platform_list_tenants
      .mockResolvedValueOnce([
        { table_name: 'field_events' },
        { table_name: 'sites' },
        { table_name: 'tenant_deletions' },
      ]) // information_schema
      .mockResolvedValueOnce([{ dump: [{ id: 'evento-1' }, { id: 'evento-2' }] }]) // field_events
      .mockResolvedValueOnce([{ dump: [] }]); // sites
    const service = conManager(manager);

    const resultado = await service.exportTenant(ACTOR, TENANT);

    expect(resultado.manifest).toMatchObject({
      tenantId: TENANT,
      slug: 'empresa-demo',
      tableCount: 2,
      totalRows: 2,
      tables: { field_events: 2, sites: 0 },
    });
    expect(resultado.data['field_events']).toEqual([{ id: 'evento-1' }, { id: 'evento-2' }]);
    // El registro de la propia solicitud no es dato del tenant: no se exporta.
    expect(resultado.data).not.toHaveProperty('tenant_deletions');
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.columns'),
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('platform_export_tenant_table'),
      [ACTOR, TENANT, 'field_events'],
    );
  });

  it('rechaza exportar una empresa inexistente', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([]); // platform_list_tenants sin el tenant
    const service = conManager(manager);

    await expect(service.exportTenant(ACTOR, TENANT)).rejects.toThrow(
      'Empresa no encontrada',
    );
  });
});

describe('TenantDataService.scheduleDeletion', () => {
  it('programa con la retencion por defecto de 30 dias', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([
        { id: TENANT, slug: 'empresa-demo', display_name: 'Empresa Demo', legal_name: 'Empresa Demo SpA', status: 'active' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'solicitud-1',
          tenant_id: TENANT,
          requested_by: ACTOR,
          requested_at: new Date(),
          purge_after: new Date('2026-09-02T00:00:00Z'),
          status: 'programado',
          reason: 'cierre de contrato firmado',
          executed_at: null,
        },
      ]);
    const service = conManager(manager);

    await expect(
      service.scheduleDeletion(ACTOR, TENANT, 'cierre de contrato firmado'),
    ).resolves.toMatchObject({ status: 'programado', tenantId: TENANT });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('make_interval(days => $4)'),
      [TENANT, ACTOR, 'cierre de contrato firmado', DEFAULT_RETENTION_DAYS],
    );
  });
});

describe('TenantDataService.cancelDeletion', () => {
  it('avisa cuando no hay nada programado que cancelar', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([]); // UPDATE sin filas
    const service = conManager(manager);

    await expect(service.cancelDeletion(ACTOR, TENANT)).rejects.toThrow(
      'No hay un borrado programado',
    );
  });
});

describe('TenantDataService.executeDeletion', () => {
  it('se niega a purgar antes de que venza la retencion', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([
        { id: 'solicitud-1', purge_after: new Date('2026-09-02T00:00:00Z'), expired: false },
      ]);
    const service = conManager(manager);

    await expect(service.executeDeletion(ACTOR, TENANT)).rejects.toThrow(
      'no se ejecuta antes',
    );
    expect(
      sqlEjecutado(manager).some((sql) => sql.includes('platform_purge_tenant')),
    ).toBe(false);
  });

  it('detecta filas huerfanas despues del DELETE y falla sin marcar ejecutado', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([
        { id: 'solicitud-1', purge_after: new Date('2026-07-01T00:00:00Z'), expired: true },
      ])
      .mockResolvedValueOnce([
        { table_name: 'field_events' },
        { table_name: 'sites' },
      ]) // information_schema
      .mockResolvedValueOnce([]) // platform_purge_tenant
      .mockResolvedValueOnce([{ remaining: '3' }]) // field_events con sobras
      .mockResolvedValueOnce([{ remaining: '0' }]); // sites limpia
    const service = conManager(manager);

    await expect(service.executeDeletion(ACTOR, TENANT)).rejects.toThrow(
      'field_events',
    );
    expect(sqlEjecutado(manager).some((sql) => sql.includes("'ejecutado'"))).toBe(false);
  });

  it('purga, verifica cero sobras y marca la solicitud como ejecutada', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([
        { id: 'solicitud-1', purge_after: new Date('2026-07-01T00:00:00Z'), expired: true },
      ])
      .mockResolvedValueOnce([{ table_name: 'sites' }]) // information_schema
      .mockResolvedValueOnce([]) // platform_purge_tenant
      .mockResolvedValueOnce([{ remaining: '0' }]) // verificacion
      .mockResolvedValueOnce([
        {
          id: 'solicitud-1',
          tenant_id: TENANT,
          requested_by: ACTOR,
          requested_at: new Date('2026-06-01T00:00:00Z'),
          purge_after: new Date('2026-07-01T00:00:00Z'),
          status: 'ejecutado',
          reason: 'cierre de contrato firmado',
          executed_at: new Date(),
        },
      ]);
    const service = conManager(manager);

    await expect(service.executeDeletion(ACTOR, TENANT)).resolves.toMatchObject({
      status: 'ejecutado',
      tenantId: TENANT,
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('platform_purge_tenant'),
      [ACTOR, TENANT],
    );
  });

  it('avisa cuando no existe una solicitud programada', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([]); // sin solicitud
    const service = conManager(manager);

    await expect(service.executeDeletion(ACTOR, TENANT)).rejects.toThrow(
      'No hay un borrado programado',
    );
  });
});
