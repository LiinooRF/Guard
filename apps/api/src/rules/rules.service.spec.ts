import { Logger } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';

import { RulesService } from './rules.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

describe('RulesService.effective', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sin fila en tenant_rules opera con los defaults del producto', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]) };
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.effective()).resolves.toEqual(patrolRulesSchema.parse({}));
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = app_tenant_id()'),
    );
  });

  it('mergea los overrides validos sobre los defaults (el umbral cambia sin deploy)', async () => {
    const manager = {
      query: jest.fn().mockResolvedValueOnce([
        { overrides: { complianceThreshold: 85, randomizeRouteOrder: true } },
      ]),
    };
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.effective()).resolves.toMatchObject({
      complianceThreshold: 85,
      randomizeRouteOrder: true,
      // lo no sobreescrito sigue en su default
      photoRequiredOutsideHours: true,
      gpsValidationRadiusM: 50,
      maxPatrolDurationMin: 480,
    });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('descarta con warning los overrides invalidos sin romper ni arrastrar a los validos', async () => {
    const manager = {
      query: jest.fn().mockResolvedValueOnce([
        {
          overrides: {
            complianceThreshold: 150, // fuera de rango
            gpsValidationRadiusM: 'cerca', // tipo invalido
            autoSendReportOnClose: false, // valido
            reglaInventada: true, // campo desconocido
          },
        },
      ]),
    };
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.effective()).resolves.toMatchObject({
      complianceThreshold: 70,
      gpsValidationRadiusM: 50,
      autoSendReportOnClose: false,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(3);
  });

  it('un jsonb que no es objeto se ignora completo y quedan los defaults', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([{ overrides: [1, 2, 3] }]) };
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.effective()).resolves.toEqual(patrolRulesSchema.parse({}));
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
  });
});

describe('RulesService.updateOverrides', () => {
  it('upsert por tenant y devuelve efectivas + overrides crudos', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ overrides: { complianceThreshold: 85 } }]); // relectura
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.updateOverrides({ complianceThreshold: 85 })).resolves.toEqual({
      effective: { ...patrolRulesSchema.parse({}), complianceThreshold: 85 },
      overrides: { complianceThreshold: 85 },
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id) DO UPDATE'),
      [JSON.stringify({ complianceThreshold: 85 })],
    );
  });

  it('un body vacio limpia los overrides y el tenant vuelve a los defaults', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ overrides: {} }]); // relectura
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.updateOverrides({})).resolves.toEqual({
      effective: patrolRulesSchema.parse({}),
      overrides: {},
    });
  });
});

describe('RulesService.adminView', () => {
  it('expone los overrides crudos aunque tengan valores invalidos, sin aplicarlos', async () => {
    const manager = {
      query: jest.fn().mockResolvedValueOnce([
        { overrides: { complianceThreshold: 999 } },
      ]),
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RulesService({ manager } as unknown as TenantContextService);

    await expect(service.adminView()).resolves.toEqual({
      effective: patrolRulesSchema.parse({}),
      overrides: { complianceThreshold: 999 },
    });
    jest.restoreAllMocks();
  });
});
