import { Logger, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';
import { QueryFailedError } from 'typeorm';

import { RulesService } from './rules.service';
import type { AuditService } from '../audit/audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { requestLogContext } from '../observability/request-context';
import { RULES_CACHE_TTL_MS, RulesLayersCache } from './rules-layers.cache';

const DEFAULTS = patrolRulesSchema.parse({});

/** Filas tal como las devuelve la consulta de cascada: una por nivel con fila. */
type Capa = { scope: string; overrides: unknown };

const ACTOR = '10000000-0000-4000-8000-000000000001';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const audit = () => ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;
const servicio = (
  query: jest.Mock,
  auditor = audit(),
  cache = new RulesLayersCache(),
  afterCommit: (callback: () => void | Promise<void>) => boolean = (callback) => {
    void callback();
    return true;
  },
) => {
  const tenantContext = {
    manager: { query },
    get tenantId() {
      return requestLogContext.current().tenantId;
    },
    afterCommit,
  } as unknown as TenantContextService;
  return new RulesService(tenantContext, auditor, cache);
};

const asTenant = <T>(tenantId: string, operation: () => T): T =>
  requestLogContext.run('rules-cache-test', () => {
    requestLogContext.setTenant(tenantId);
    return operation();
  });

const capas = (...filas: Capa[]) => jest.fn().mockResolvedValueOnce(filas);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
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
      // lo no sobreescrito sigue en su default (false desde la decision de
      // producto del 8-ago: la foto la exige una tarea, no el reloj)
      photoRequiredOutsideHours: false,
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

  it('reduce una lectura repetida del mismo contexto a una sola consulta de cascada', async () => {
    const query = jest.fn().mockResolvedValue([
      { scope: 'tenant', overrides: { complianceThreshold: 81 } },
    ]);
    const rules = servicio(query);

    const first = await asTenant(TENANT_A, () =>
      rules.effective({ siteId: 'site-a' }),
    );
    const repeated = await asTenant(TENANT_A, () => rules.effective({ siteId: 'site-a' }));

    expect(first.complianceThreshold).toBe(81);
    expect(repeated.complianceThreshold).toBe(81);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('aisla la cache por tenant aunque ambos pidan el mismo contexto', async () => {
    const query = jest.fn().mockImplementation(async () => [
      {
        scope: 'tenant',
        overrides: {
          complianceThreshold: requestLogContext.current().tenantId === TENANT_A ? 81 : 92,
        },
      },
    ]);
    const rules = servicio(query);

    const tenantA = await asTenant(TENANT_A, () => rules.effective({ siteId: 'same-site' }));
    const tenantB = await asTenant(TENANT_B, () => rules.effective({ siteId: 'same-site' }));
    const tenantARepeated = await asTenant(TENANT_A, () =>
      rules.effective({ siteId: 'same-site' }),
    );

    expect(tenantA.complianceThreshold).toBe(81);
    expect(tenantB.complianceThreshold).toBe(92);
    expect(tenantARepeated.complianceThreshold).toBe(81);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('sin tenant autenticado no reutiliza una entrada que podria cruzar empresas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 81 } }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 92 } }]);
    const rules = servicio(query);

    await expect(rules.effective({ siteId: 'same-site' })).resolves.toMatchObject({
      complianceThreshold: 81,
    });
    await expect(rules.effective({ siteId: 'same-site' })).resolves.toMatchObject({
      complianceThreshold: 92,
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('separa las claves sin contexto, por recinto y por punto', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 71 } }])
      .mockResolvedValueOnce([{ scope: 'site', overrides: { complianceThreshold: 72 } }])
      .mockResolvedValueOnce([{ scope: 'checkpoint', overrides: { gpsValidationRadiusM: 73 } }]);
    const rules = servicio(query);

    await asTenant(TENANT_A, async () => {
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 71 });
      await expect(rules.effective({ siteId: 'site-a' })).resolves.toMatchObject({
        complianceThreshold: 72,
      });
      await expect(rules.effective({ checkpointId: 'checkpoint-a' })).resolves.toMatchObject({
        gpsValidationRadiusM: 73,
      });
      await rules.effective();
      await rules.effective({ siteId: 'site-a' });
      await rules.effective({ checkpointId: 'checkpoint-a' });
    });

    expect(query).toHaveBeenCalledTimes(3);
  });

  it('vuelve a PostgreSQL al vencer el TTL de 45 segundos', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 81 } }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 92 } }]);
    const rules = servicio(query);

    await asTenant(TENANT_A, async () => {
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 81 });
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 81 });
      jest.advanceTimersByTime(RULES_CACHE_TTL_MS);
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 92 });
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('si la cache falla degrada a PostgreSQL y nunca a defaults', async () => {
    const query = jest.fn().mockResolvedValue([
      { scope: 'tenant', overrides: { complianceThreshold: 88 } },
    ]);
    const brokenCache = {
      captureGeneration: jest.fn(() => ({ global: 0, tenant: 0 })),
      get: jest.fn(() => {
        throw new Error('cache read unavailable');
      }),
      setIfCurrent: jest.fn(() => {
        throw new Error('cache write unavailable');
      }),
    } as unknown as RulesLayersCache;

    await expect(
      asTenant(TENANT_A, () => servicio(query, audit(), brokenCache).effective()),
    ).resolves.toMatchObject({ complianceThreshold: 88 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'rules_cache_failure', operation: 'get' }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'rules_cache_failure', operation: 'set' }),
    );
  });

  it('si PostgreSQL falla propaga el error en vez de abrir con defaults', async () => {
    const databaseError = new Error('database unavailable');
    const query = jest.fn().mockRejectedValue(databaseError);

    await expect(
      asTenant(TENANT_A, () => servicio(query).effective()),
    ).rejects.toBe(databaseError);
  });
});

describe('RulesService.effectiveWithSource', () => {
  it('dice de que nivel salio cada valor (la app no reimplementa la cascada)', async () => {
    const query = capas(
      { scope: 'platform', overrides: { allowQrFallback: false } },
      { scope: 'tenant', overrides: { complianceThreshold: 85 } },
      { scope: 'site', overrides: { complianceThreshold: 90, gpsSharingMandatory: false } },
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
      gpsSharingMandatory: false,
    });
    expect(resultado.sources).toMatchObject({
      complianceThreshold: 'site',
      allowQrFallback: 'platform',
      gpsSharingMandatory: 'site',
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
      { reportRecipients: ['privado@cliente.cl'], gpsSharingMandatory: true },
      ACTOR,
    );

    expect(auditor.record).toHaveBeenCalledWith({
      actorId: ACTOR,
      actorLabel: 'Ana Admin',
      action: 'reglas.modificadas',
      entityType: 'tenant_rules',
      entityId: undefined,
      summary: 'tenant: 2 regla(s) configurada(s): gpsSharingMandatory, reportRecipients',
    });
    expect(JSON.stringify((auditor.record as jest.Mock).mock.calls)).not.toContain(
      'privado@cliente.cl',
    );
  });

  it('invalida el tenant y no cachea la vista antes del commit HTTP', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 71 } }])
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 82 } }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 82 } }]);
    const cache = new RulesLayersCache();
    const pendingAfterCommit: Array<() => void | Promise<void>> = [];
    const rules = servicio(query, audit(), cache, (callback) => {
      pendingAfterCommit.push(callback);
      return true;
    });

    await asTenant(TENANT_A, async () => {
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 71 });
      await expect(rules.updateOverrides({ complianceThreshold: 82 }, ACTOR)).resolves.toMatchObject(
        { effective: { complianceThreshold: 82 } },
      );

      // La escritura aun no fue confirmada: solo quedo registrado el hook.
      expect(cache.stats()).toMatchObject({ invalidations: 0, size: 1 });
      expect(pendingAfterCommit).toHaveLength(1);
      await pendingAfterCommit[0]?.();

      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 82 });
      await expect(rules.effective()).resolves.toMatchObject({ complianceThreshold: 82 });
    });

    const cascadeQueries = query.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT 'platform' AS scope"),
    );
    expect(cascadeQueries).toHaveLength(3);
    expect(cache.stats()).toMatchObject({ invalidations: 1, hits: 1 });
  });

  it('un fallo de invalidacion no convierte una escritura tenant en falso 500', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ label: 'Ana Admin' }])
      .mockResolvedValueOnce([{ scope: 'tenant', overrides: { complianceThreshold: 82 } }]);
    const brokenCache = {
      invalidateTenant: jest.fn(() => {
        throw new Error('cache unavailable');
      }),
    } as unknown as RulesLayersCache;
    const pendingAfterCommit: Array<() => void | Promise<void>> = [];

    await expect(
      asTenant(TENANT_A, () =>
        servicio(query, audit(), brokenCache, (callback) => {
          pendingAfterCommit.push(callback);
          return true;
        }).updateOverrides({ complianceThreshold: 82 }, ACTOR),
      ),
    ).resolves.toMatchObject({ effective: { complianceThreshold: 82 } });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();

    await pendingAfterCommit[0]?.();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'rules_cache_failure', operation: 'invalidate_tenant' }),
    );
  });

  it('un SELECT anterior al commit no puede repoblar el valor invalidado', async () => {
    let releaseOldSelect: ((rows: Capa[]) => void) | undefined;
    const oldSelect = new Promise<Capa[]>((resolve) => {
      releaseOldSelect = resolve;
    });
    let cascadeReads = 0;
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT 'platform' AS scope")) {
        cascadeReads += 1;
        if (cascadeReads === 1) return oldSelect;
        return Promise.resolve([
          { scope: 'tenant', overrides: { complianceThreshold: 92 } },
        ]);
      }
      if (sql.includes('INSERT INTO tenant_rules')) return Promise.resolve([]);
      if (sql.includes('FROM users WHERE id')) {
        return Promise.resolve([{ label: 'Ana Admin' }]);
      }
      return Promise.resolve([]);
    });
    const cache = new RulesLayersCache();
    const pendingAfterCommit: Array<() => void | Promise<void>> = [];
    const rules = servicio(query, audit(), cache, (callback) => {
      pendingAfterCommit.push(callback);
      return true;
    });

    const readStartedBeforeCommit = asTenant(TENANT_A, () => rules.effective());
    await Promise.resolve();

    await asTenant(TENANT_A, () =>
      rules.updateOverrides({ complianceThreshold: 92 }, ACTOR),
    );
    await pendingAfterCommit[0]?.();
    releaseOldSelect?.([
      { scope: 'tenant', overrides: { complianceThreshold: 71 } },
    ]);

    // La request que ya leia puede terminar con su snapshot anterior, pero no
    // debe publicarlo para las siguientes requests.
    await expect(readStartedBeforeCommit).resolves.toMatchObject({ complianceThreshold: 71 });
    expect(cache.stats()).toMatchObject({ staleWritesRejected: 1, size: 0 });

    await expect(
      asTenant(TENANT_A, () => rules.effective()),
    ).resolves.toMatchObject({ complianceThreshold: 92 });
    await asTenant(TENANT_A, () => rules.effective());
    expect(cascadeReads).toBe(3);
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
    const cache = new RulesLayersCache();
    const invalidar = jest.spyOn(cache, 'invalidateTenant');

    const vista = await asTenant(TENANT_A, () =>
      servicio(query, audit(), cache).updateSiteOverrides(
        'a0000000-0000-4000-8000-000000000009',
        { complianceThreshold: 95 },
        ACTOR,
      ),
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
    expect(invalidar).toHaveBeenCalledWith(TENANT_A);
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
    const cache = new RulesLayersCache();
    const invalidar = jest.spyOn(cache, 'invalidateTenant');

    const vista = await asTenant(TENANT_A, () =>
      servicio(query, audit(), cache).updateCheckpointOverrides(
        'c0000000-0000-4000-8000-000000000009',
        { gpsValidationRadiusM: 150 },
        ACTOR,
      ),
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, checkpoint_id) DO UPDATE'),
      ['c0000000-0000-4000-8000-000000000009', JSON.stringify({ gpsValidationRadiusM: 150 })],
    );
    expect(vista.effective.gpsValidationRadiusM).toBe(150);
    expect(vista.sources.gpsValidationRadiusM).toBe('checkpoint');
    expect(invalidar).toHaveBeenCalledWith(TENANT_A);
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
