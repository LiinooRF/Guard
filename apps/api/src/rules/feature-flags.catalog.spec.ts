import { Logger } from '@nestjs/common';
import { DEFAULT_FEATURE_FLAGS, featureFlagsSchema } from '@voxia/shared';

import {
  FEATURE_CATALOG,
  FEATURE_FLAG_KEYS,
  FEATURE_MODULE_LIST,
  modulesOutsideLicense,
  resolveFeatureFlags,
  sanitizeFeatureFlags,
} from './feature-flags.catalog';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('catalogo de modulos', () => {
  it('describe TODOS los flags del contrato compartido y ninguno de mas', () => {
    expect(FEATURE_FLAG_KEYS.slice().sort()).toEqual(
      Object.keys(featureFlagsSchema.shape).sort(),
    );
  });

  it('cada modulo dice que hace y que deja de verse cuando se apaga', () => {
    for (const modulo of FEATURE_MODULE_LIST) {
      expect(modulo.label.length).toBeGreaterThan(0);
      expect(modulo.description.length).toBeGreaterThan(0);
      expect(modulo.whenOff.length).toBeGreaterThan(0);
      expect(modulo.default).toBe(DEFAULT_FEATURE_FLAGS[modulo.key]);
    }
  });

  it('no incluye optimizacion de rutas: esa decision esta descartada', () => {
    // Una ronda "optima" es una ronda predecible, y la predictibilidad es lo que
    // explota quien quiere entrar. Se descarto explicitamente en CLAUDE.md; si
    // alguien la reintroduce como modulo vendible, este test lo frena.
    expect(Object.keys(FEATURE_CATALOG)).not.toContain('routeOptimization');
  });
});

describe('resolveFeatureFlags', () => {
  it('sin ningun nivel guardado opera con los valores de fabrica', () => {
    const resuelto = resolveFeatureFlags({});
    expect(resuelto.enabled).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(resuelto.entitlements).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(resuelto.sources.map).toBe('producto');
  });

  it('el plan apaga un modulo y desaparece para toda empresa de ese plan', () => {
    const resuelto = resolveFeatureFlags({ plan: { chartsBySite: false } });

    expect(resuelto.enabled.chartsBySite).toBe(false);
    expect(resuelto.entitlements.chartsBySite).toBe(false);
    expect(resuelto.sources.chartsBySite).toBe('plan');
    // lo que el plan no menciona sigue como viene de fabrica
    expect(resuelto.enabled.map).toBe(true);
  });

  it('la concesion a la empresa le gana al plan, en los dos sentidos', () => {
    const regalado = resolveFeatureFlags({
      plan: { chartsBySite: false },
      empresa: { chartsBySite: true },
    });
    expect(regalado.enabled.chartsBySite).toBe(true);
    expect(regalado.sources.chartsBySite).toBe('empresa');

    const quitado = resolveFeatureFlags({
      plan: { map: true },
      empresa: { map: false },
    });
    expect(quitado.enabled.map).toBe(false);
    expect(quitado.sources.map).toBe('empresa');
  });

  it('el admin apaga dentro de lo que su licencia incluye', () => {
    const resuelto = resolveFeatureFlags({
      plan: { photoAppendix: true },
      admin: { photoAppendix: false },
    });

    expect(resuelto.entitlements.photoAppendix).toBe(true);
    expect(resuelto.enabled.photoAppendix).toBe(false);
    expect(resuelto.sources.photoAppendix).toBe('admin');
  });

  it('la preferencia del admin NO alcanza para activar lo que la licencia niega', () => {
    // Es el criterio de aceptacion del issue: aunque quede escrito un true en la
    // preferencia (panel viejo, plan que bajaron despues), el modulo sigue
    // apagado y el panel dice que la razon es el plan, no el admin.
    const resuelto = resolveFeatureFlags({
      plan: { map: false },
      admin: { map: true },
    });

    expect(resuelto.enabled.map).toBe(false);
    expect(resuelto.sources.map).toBe('plan');
    expect(resuelto.editable.map((modulo) => modulo.key)).not.toContain('map');
  });

  it('solo lista como editable lo que la licencia incluye', () => {
    const resuelto = resolveFeatureFlags({ plan: { chartsBySite: false, crashReporting: true } });
    const editables = resuelto.editable.map((modulo) => modulo.key);

    expect(editables).not.toContain('chartsBySite');
    expect(editables).toContain('crashReporting');
    expect(editables).toContain('map');
  });

  it('bajar el plan apaga el modulo sin tener que limpiar lo que el admin escribio', () => {
    const antes = resolveFeatureFlags({ plan: { incidents: true }, admin: { incidents: true } });
    const despues = resolveFeatureFlags({ plan: { incidents: false }, admin: { incidents: true } });

    expect(antes.enabled.incidents).toBe(true);
    expect(despues.enabled.incidents).toBe(false);
  });
});

describe('modulesOutsideLicense', () => {
  it('nombra los modulos que se intentan prender sin tenerlos', () => {
    const { entitlements } = resolveFeatureFlags({ plan: { map: false } });
    const fuera = modulesOutsideLicense({ map: true, incidents: true }, entitlements);

    expect(fuera.map((modulo) => modulo.key)).toEqual(['map']);
    // El mensaje que ve el jefe de operaciones usa el nombre del modulo.
    expect(fuera[0]?.label).toBe('Mapa en vivo');
  });

  it('apagar lo que no se tiene no es un intento de activarlo', () => {
    const { entitlements } = resolveFeatureFlags({ plan: { map: false } });
    expect(modulesOutsideLicense({ map: false }, entitlements)).toHaveLength(0);
  });
});

describe('sanitizeFeatureFlags', () => {
  const logger = () => new Logger('prueba');

  it('descarta lo desconocido y lo que no es booleano, sin romper el resto', () => {
    const limpio = sanitizeFeatureFlags(
      { map: true, incidents: 'si', moduloInventado: true },
      'plan',
      logger(),
    );

    expect(limpio).toEqual({ map: true });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
  });

  it('un jsonb que no es objeto se ignora completo', () => {
    expect(sanitizeFeatureFlags([1, 2, 3], 'admin', logger())).toEqual({});
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('modulos_no_objeto'),
    );
  });

  it('null y undefined son "este nivel no opina", no un error', () => {
    expect(sanitizeFeatureFlags(null, 'plan', logger())).toEqual({});
    expect(sanitizeFeatureFlags(undefined, 'plan', logger())).toEqual({});
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
});
