import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import { FeatureFlagsPlatformService } from './feature-flags-platform.service';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const EMPRESA = '22222222-2222-4222-8222-222222222222';

/** DataSource falso: `query` para las lecturas y `transaction` para la escritura. */
const fuente = (query: jest.Mock) =>
  ({
    query,
    transaction: (operacion: (manager: { query: jest.Mock }) => Promise<unknown>) =>
      operacion({ query }),
  }) as unknown as DataSource;

const errorDeBase = (codigo: string) => {
  const fallo = new QueryFailedError('select', [], new Error(codigo));
  (fallo as unknown as { driverError: { code: string } }).driverError = { code: codigo };
  return fallo;
};

const FILA_PLAN = {
  plan_key: 'base',
  plan_name: 'Base',
  flags: { chartsBySite: false },
  tenant_count: 7,
  updated_at: new Date('2026-01-01T00:00:00Z'),
  updated_by: ACTOR,
};

const FILA_EMPRESA = {
  tenant_id: EMPRESA,
  display_name: 'Seguridad Andes',
  plan_key: 'base',
  plan_name: 'Base',
  plan_flags: { chartsBySite: false },
  tenant_grants: { chartsBySite: true },
  tenant_preferences: { map: false },
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('FeatureFlagsPlatformService.plans', () => {
  it('resuelve que incluye cada plan y cuantas empresas lo tienen', async () => {
    const query = jest.fn().mockResolvedValueOnce([FILA_PLAN]);

    const vista = await new FeatureFlagsPlatformService(fuente(query)).plans(ACTOR);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('platform_list_plan_features($1)'),
      [ACTOR],
    );
    expect(vista.plans[0]).toMatchObject({
      key: 'base',
      name: 'Base',
      tenantCount: 7,
      flags: { chartsBySite: false },
    });
    expect(vista.plans[0]?.includes.chartsBySite).toBe(false);
    // lo que el plan no menciona sigue viniendo de fabrica
    expect(vista.plans[0]?.includes.map).toBe(true);
    expect(vista.plans[0]?.sources.chartsBySite).toBe('plan');
  });

  it('sin planes devuelve la lista vacia y el catalogo igual', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const vista = await new FeatureFlagsPlatformService(fuente(query)).plans(ACTOR);

    expect(vista.plans).toEqual([]);
    expect(vista.modules.length).toBeGreaterThan(0);
  });
});

describe('FeatureFlagsPlatformService.replacePlanFeatures', () => {
  it('escribe por la funcion con control de SUPERADMIN, no con un UPDATE suelto', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([]) // set_config del actor
      .mockResolvedValueOnce([]) // platform_set_plan_features
      .mockResolvedValueOnce([{ ...FILA_PLAN, flags: { chartsBySite: true } }]);

    const vista = await new FeatureFlagsPlatformService(fuente(query)).replacePlanFeatures(
      ACTOR,
      'base',
      { chartsBySite: true },
    );

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("set_config('app.user_id'"), [
      ACTOR,
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('platform_set_plan_features'), [
      ACTOR,
      'base',
      JSON.stringify({ chartsBySite: true }),
    ]);
    expect(vista.plans[0]?.includes.chartsBySite).toBe(true);
  });

  it('si la base rechaza al actor responde 403 y no 500', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(errorDeBase('42501'));

    await expect(
      new FeatureFlagsPlatformService(fuente(query)).replacePlanFeatures(ACTOR, 'base', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un plan inexistente responde 404 y no 500', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(errorDeBase('23503'));

    await expect(
      new FeatureFlagsPlatformService(fuente(query)).replacePlanFeatures(ACTOR, 'inventado', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FeatureFlagsPlatformService.tenantFeatures', () => {
  it('muestra el plan, la concesion, lo que prendio el admin y el resultado', async () => {
    const query = jest.fn().mockResolvedValueOnce([FILA_EMPRESA]);

    const vista = await new FeatureFlagsPlatformService(fuente(query)).tenantFeatures(
      ACTOR,
      EMPRESA,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('platform_tenant_features($1, $2)'),
      [ACTOR, EMPRESA],
    );
    // la concesion le gana al plan
    expect(vista.entitlements.chartsBySite).toBe(true);
    expect(vista.entitlementSources.chartsBySite).toBe('empresa');
    // y el admin apago el mapa, que su plan si incluia
    expect(vista.enabled.map).toBe(false);
    expect(vista.sources.map).toBe('admin');
  });

  it('una empresa que no existe responde 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await expect(
      new FeatureFlagsPlatformService(fuente(query)).tenantFeatures(ACTOR, EMPRESA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FeatureFlagsPlatformService.replaceTenantFeatures', () => {
  it('guarda la concesion y devuelve la empresa ya resuelta', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([]) // set_config
      .mockResolvedValueOnce([]) // platform_set_tenant_features
      .mockResolvedValueOnce([{ ...FILA_EMPRESA, tenant_grants: { map: false } }]);

    const vista = await new FeatureFlagsPlatformService(fuente(query)).replaceTenantFeatures(
      ACTOR,
      EMPRESA,
      { map: false },
    );

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('platform_set_tenant_features'),
      [ACTOR, EMPRESA, JSON.stringify({ map: false })],
    );
    // Quitarle el modulo lo apaga aunque el admin lo tenga prendido: es un AND.
    expect(vista.enabled.map).toBe(false);
    expect(vista.entitlements.map).toBe(false);
  });

  it('el log de la operacion lleva tenant_id y nada mas', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([FILA_EMPRESA]);

    await new FeatureFlagsPlatformService(fuente(query)).replaceTenantFeatures(ACTOR, EMPRESA, {});

    const registrado = (Logger.prototype.log as jest.Mock).mock.calls[0][0] as string;
    expect(registrado).toContain(EMPRESA);
    // Nada de nombres de empresa ni de personas en los logs.
    expect(registrado).not.toContain('Seguridad Andes');
    expect(registrado).not.toContain(ACTOR);
  });

  it('una empresa inexistente responde 404 por el FK, no 500', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(errorDeBase('23503'));

    await expect(
      new FeatureFlagsPlatformService(fuente(query)).replaceTenantFeatures(ACTOR, EMPRESA, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
