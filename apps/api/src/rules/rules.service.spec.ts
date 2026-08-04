import { Logger, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';
import { QueryFailedError } from 'typeorm';

import { RulesService } from './rules.service';
import type { AuditService } from '../audit/audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

const DEFAULTS = patrolRulesSchema.parse({});

/** Filas tal como las devuelve la consulta de cascada: una por nivel con fila. */
type Capa = { scope: string; overrides: unknown };

const ACTOR = '10000000-0000-4000-8000-000000000001';
const audit = () => ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;
const servicio = (query: jest.Mock, auditor = audit()) =>
  new RulesService({ manager: { query } } as unknown as TenantContextService, auditor);

const capas = (...filas: Capa[]) => jest.fn().mockResolvedValueOnce(filas);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('RulesService.effective', () => {
  it('sin ninguna fila opera con los defaults del producto', async () => {
    const query = capas();
    await expect(servicio(query).effective()).resolves.toEqual(DEFAULTS);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = app_tenant_id()'),
      [null, null],
    );
  });

  it('mergea los overrides validos sobre los defaults (el umbral cambia sin deploy)', async () => {
    const query = capas({
      scope: 'tenant',
      overrides: { complianceThreshold: 85, randomizeRouteOrder: true },
    });

    await expect(servicio(query).effective()).resolves.toMatchObject({
      complianceThreshold: 85,
      randomizeRouteOrder: true,
      // lo no sobreescrito sigue en su default
      photoRequiredOutsideHours: true,
      gpsValidationRadiusM: 50,
      maxPatrolDurationMin: 480,
    });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('el nivel mas especifico gana en toda la cascada', async () => {
    const query = capas(
      { scope: 'platform', overrides: { complianceThreshold: 60, allowQrFallback: false } },
      { scope: 'tenant', overrides: { complianceThreshold: 85, gpsValidationRadiusM: 30 } },
      { scope: 'site', overrides: { complianceThreshold: 90 } },
      { scope: 'checkpoint', overrides: { gpsValidationRadiusM: 120 } },
    );

    await expect(
      servicio(query).effective({ checkpointId: 'c0000000-0000-4000-8000-000000000001' }),
    ).resolves.toMatchObject({
      // el recinto le gana al tenant y a la plataforma
      complianceThreshold: 90,
      // el punto le gana al tenant
      gpsValidationRadiusM: 120,
      // nadie piso lo de plataforma
      allowQrFallback: false,
      // sin override en ningun nivel, queda el default del producto
      photoRetentionDays: 365,
    });
  });

  it('pide la cascada con el recinto y el punto del contexto', async () => {
    const query = capas();
    await servicio(query).effective({
      siteId: 'a0000000-0000-4000-8000-000000000009',
      checkpointId: 'c0000000-0000-4000-8000-000000000009',
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'a0000000-0000-4000-8000-000000000009',
      'c0000000-0000-4000-8000-000000000009',
    ]);
  });

  it('descarta con warning los overrides invalidos sin romper ni arrastrar a los validos', async () => {
    const query = capas({
      scope: 'tenant',
      overrides: {
        complianceThreshold: 150, // fuera de rango
        gpsValidationRadiusM: 'cerca', // tipo invalido
        autoSendReportOnClose: false, // valido
        reglaInventada: true, // campo desconocido
      },
    });

    await expect(servicio(query).effective()).resolves.toMatchObject({
      complianceThreshold: 70,
      gpsValidationRadiusM: 50,
      autoSendReportOnClose: false,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(3);
  });

  it('ignora el override guardado en un nivel donde esa regla no se configura', async () => {
    const query = capas({
      scope: 'checkpoint',
      // La retencion es politica de la empresa completa: en un punto no aplica.
      overrides: { photoRetentionDays: 30, gpsValidationRadiusM: 200 },
    });

    await expect(
      servicio(query).effective({ checkpointId: 'c0000000-0000-4000-8000-000000000001' }),
    ).resolves.toMatchObject({
      photoRetentionDays: 365,
      gpsValidationRadiusM: 200,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('regla_fuera_de_nivel_descartada'),
    );
  });

  it('un jsonb que no es objeto se ignora completo y quedan los defaults', async () => {
    const query = capas({ scope: 'tenant', overrides: [1, 2, 3] });

    await expect(servicio(query).effective()).resolves.toEqual(DEFAULTS);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
  });
});

describe('RulesService.effectiveWithSource', () => {
  it('dice de que nivel salio cada valor (la app no reimplementa la cascada)', async () => {
    const query = capas(
      { scope: 'platform', overrides: { allowQrFallback: false } },
      { scope: 'tenant', overrides: { complianceThreshold: 85 } },
      { scope: 'site', overrides: { complianceThreshold: 90, gpsSharingRequired: false } },
    );

    const resultado = await servicio(query).effectiveWithSource({
      siteId: 'a0000000-0000-4000-8000-000000000009',
    });

    expect(resultado.context).toEqual({
      siteId: 'a0000000-0000-4000-8000-000000000009',
      checkpointId: null,
    });
    expect(resultado.rules).toMatchObject({
      complianceThreshold: 90,
      allowQrFallback: false,
      gpsSharingRequired: false,
    });
    expect(resultado.sources).toMatchObject({
      complianceThreshold: 'site',
      allowQrFallback: 'platform',
      gpsSharingRequired: 'site',
      // nadie lo sobreescribio: viene del default del producto
      photoRetentionDays: 'default',
    });
    expect(resultado.layers.tenant).toEqual({ complianceThreshold: 85 });
  });
});

describe('RulesService.updateOverrides', () => {
  it('upsert por tenant y devuelve la vista del nivel empresa', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ label: 'Ana Admin' }]) // actor de auditoria
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 85 } }]);

    await expect(
      servicio(query).updateOverrides({ complianceThreshold: 85 }, ACTOR),
    ).resolves.toMatchObject(
      {
        scope: 'tenant',
        effective: { ...DEFAULTS, complianceThreshold: 85 },
        overrides: { complianceThreshold: 85 },
      },
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id) DO UPDATE'),
      [JSON.stringify({ complianceThreshold: 85 })],
    );
  });

  it('un body vacio limpia los overrides y el tenant vuelve a lo heredado', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: {} }]);

    await expect(servicio(query).updateOverrides({}, ACTOR)).resolves.toMatchObject({
      effective: DEFAULTS,
      overrides: {},
    });
  });

  it('audita actor y alcance sin copiar valores configurados al historial', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { reportRecipients: [] } }]);
    const auditor = audit();

    await servicio(query, auditor).updateOverrides(
      { reportRecipients: ['privado@cliente.cl'], gpsSharingRequired: true },
      ACTOR,
    );

    expect(auditor.record).toHaveBeenCalledWith({
      actorId: ACTOR,
      actorLabel: 'Ana Admin',
      action: 'reglas.modificadas',
      entityType: 'tenant_rules',
      entityId: undefined,
      summary: 'tenant: 2 regla(s) configurada(s): gpsSharingRequired, reportRecipients',
    });
    expect(JSON.stringify((auditor.record as jest.Mock).mock.calls)).not.toContain(
      'privado@cliente.cl',
    );
  });
});

describe('RulesService.updateSiteOverrides', () => {
  it('escribe solo el recinto pedido y devuelve su vista', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([
        { scope: 'tenant', overrides: { complianceThreshold: 85 } },
        { scope: 'site', overrides: { complianceThreshold: 95 } },
      ]);

    const vista = await servicio(query).updateSiteOverrides(
      'a0000000-0000-4000-8000-000000000009',
      { complianceThreshold: 95 },
      ACTOR,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, site_id) DO UPDATE'),
      ['a0000000-0000-4000-8000-000000000009', JSON.stringify({ complianceThreshold: 95 })],
    );
    expect(vista).toMatchObject({
      scope: 'site',
      targetId: 'a0000000-0000-4000-8000-000000000009',
      effective: expect.objectContaining({ complianceThreshold: 95 }),
      overrides: { complianceThreshold: 95 },
      sources: expect.objectContaining({ complianceThreshold: 'site' }),
    });
  });

  it('un recinto de otra empresa no existe: el FK compuesto lo corta y responde 404', async () => {
    const fk = new QueryFailedError('insert', [], new Error('fk'));
    (fk as unknown as { driverError: { code: string } }).driverError = { code: '23503' };
    const query = jest.fn().mockRejectedValueOnce(fk);

    await expect(
      servicio(query).updateSiteOverrides(
        'a0000000-0000-4000-8000-000000000404',
        {},
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RulesService.updateCheckpointOverrides', () => {
  it('escribe el punto y devuelve la cascada resuelta hasta ese punto', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([{ scope: 'checkpoint', overrides: { gpsValidationRadiusM: 150 } }]);

    const vista = await servicio(query).updateCheckpointOverrides(
      'c0000000-0000-4000-8000-000000000009',
      { gpsValidationRadiusM: 150 },
      ACTOR,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, checkpoint_id) DO UPDATE'),
      ['c0000000-0000-4000-8000-000000000009', JSON.stringify({ gpsValidationRadiusM: 150 })],
    );
    expect(vista.effective.gpsValidationRadiusM).toBe(150);
    expect(vista.sources.gpsValidationRadiusM).toBe('checkpoint');
  });

  it('un punto inexistente responde 404 y no 500', async () => {
    const fk = new QueryFailedError('insert', [], new Error('fk'));
    (fk as unknown as { driverError: { code: string } }).driverError = { code: '23503' };
    const query = jest.fn().mockRejectedValueOnce(fk);

    await expect(
      servicio(query).updateCheckpointOverrides(
        'c0000000-0000-4000-8000-000000000404',
        {},
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RulesService.adminView', () => {
  it('expone los overrides crudos aunque tengan valores invalidos, sin aplicarlos', async () => {
    const query = capas({ scope: 'tenant', overrides: { complianceThreshold: 999 } });

    await expect(servicio(query).adminView()).resolves.toMatchObject({
      scope: 'tenant',
      effective: DEFAULTS,
      overrides: { complianceThreshold: 999 },
    });
  });

  it('entrega el catalogo de lo editable en ese nivel, para que la interfaz no lo sepa de memoria', async () => {
    const query = capas();
    const vista = await servicio(query).adminView();

    expect(vista.editable.length).toBeGreaterThan(0);
    expect(vista.editable.every((parametro) => parametro.scopes.includes('tenant'))).toBe(true);
  });
});
