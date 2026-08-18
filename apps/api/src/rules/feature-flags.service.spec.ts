import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { DEFAULT_FEATURE_FLAGS } from '@sentrycore/shared';
import { QueryFailedError } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { FeatureFlagsService } from './feature-flags.service';

/** Fila tal como la devuelve la consulta de niveles: una por nivel con fila. */
type Nivel = { nivel: string; flags: unknown; plan_key?: string | null; plan_name?: string | null };

const servicio = (query: jest.Mock) =>
  new FeatureFlagsService({ manager: { query } } as unknown as TenantContextService);

const PLAN_BASE = { nivel: 'plan', plan_key: 'base', plan_name: 'Base' };

/** Una lectura de niveles. La consulta es un SELECT: devuelve filas planas. */
const niveles = (...filas: Nivel[]) => jest.fn().mockResolvedValueOnce(filas);

const errorDeBase = (codigo: string) => {
  const fallo = new QueryFailedError('insert', [], new Error(codigo));
  (fallo as unknown as { driverError: { code: string } }).driverError = { code: codigo };
  return fallo;
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('FeatureFlagsService.effective', () => {
  it('una empresa sin nada configurado tiene los modulos de fabrica', async () => {
    const query = niveles({ ...PLAN_BASE, flags: {} });

    await expect(servicio(query).effective()).resolves.toEqual(DEFAULT_FEATURE_FLAGS);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('app_tenant_id()'));
  });

  it('sin contexto de tenant no vuelve ninguna fila y quedan los de fabrica', async () => {
    // La consulta cuelga entera de app_tenant_id(): sin contexto no trae nada.
    // Falla cerrada, igual que RLS.
    await expect(servicio(niveles()).effective()).resolves.toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('lo que el plan no incluye queda apagado', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: { map: false, chartsBySite: false } },
    );

    const modulos = await servicio(query).effective();
    expect(modulos.map).toBe(false);
    expect(modulos.chartsBySite).toBe(false);
    expect(modulos.photoAppendix).toBe(true);
  });

  it('la concesion a la empresa le gana al plan', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: { map: false } },
      { nivel: 'empresa', flags: { map: true } },
    );

    await expect(servicio(query).effective()).resolves.toMatchObject({ map: true });
  });

  it('el admin apaga lo suyo sin tocar el resto', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: {} },
      { nivel: 'admin', flags: { photoAppendix: false } },
    );

    const modulos = await servicio(query).effective();
    expect(modulos.photoAppendix).toBe(false);
    expect(modulos.chartsBySite).toBe(true);
  });

  it('un true guardado por el admin no levanta lo que el plan niega', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: { map: false } },
      { nivel: 'admin', flags: { map: true } },
    );

    await expect(servicio(query).effective()).resolves.toMatchObject({ map: false });
  });

  it('una preferencia corrupta se descarta con warning y la operacion sigue', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: {} },
      { nivel: 'admin', flags: { photoAppendix: 'quizas', moduloViejo: true } },
    );

    await expect(servicio(query).effective()).resolves.toMatchObject({ photoAppendix: true });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
  });
});

describe('FeatureFlagsService.assertEnabled', () => {
  it('un modulo apagado responde 404: desaparece, no queda bloqueado', async () => {
    const query = niveles({ ...PLAN_BASE, flags: { photoAppendix: false } });

    await expect(servicio(query).assertEnabled('photoAppendix')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un modulo prendido deja pasar', async () => {
    const query = niveles({ ...PLAN_BASE, flags: {} });
    await expect(servicio(query).assertEnabled('photoAppendix')).resolves.toBeUndefined();
  });
});

describe('FeatureFlagsService.adminView', () => {
  it('muestra el plan, el techo y SOLO lo que el admin puede tocar', async () => {
    const query = niveles(
      { ...PLAN_BASE, flags: { chartsBySite: false } },
      { nivel: 'admin', flags: { map: false } },
    );

    const vista = await servicio(query).adminView();

    expect(vista.plan).toEqual({ key: 'base', name: 'Base' });
    expect(vista.entitlements.chartsBySite).toBe(false);
    expect(vista.enabled.map).toBe(false);
    expect(vista.sources.map).toBe('admin');
    expect(vista.sources.chartsBySite).toBe('plan');
    expect(vista.editable.map((modulo) => modulo.key)).not.toContain('chartsBySite');
    // Lo crudo se muestra igual: el admin tiene que ver lo que dejo escrito.
    expect(vista.stored).toEqual({ map: false });
  });
});

describe('FeatureFlagsService.replacePreferences', () => {
  it('guarda el set completo y devuelve la vista actualizada', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: {} }]) // lectura previa
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([
        { ...PLAN_BASE, flags: {} },
        { nivel: 'admin', flags: { photoAppendix: false } },
      ]);

    const vista = await servicio(query).replacePreferences({ photoAppendix: false });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (tenant_id) DO UPDATE'),
      [JSON.stringify({ photoAppendix: false })],
    );
    expect(vista.enabled.photoAppendix).toBe(false);
  });

  it('el admin no puede activar un modulo que su licencia no incluye', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: { map: false } }]);

    await expect(
      servicio(query).replacePreferences({ map: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Y ni siquiera intenta escribir.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('el mensaje nombra el modulo como lo conoce el jefe de operaciones', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: { chartsBySite: false } }]);

    await expect(
      servicio(query).replacePreferences({ chartsBySite: true }),
    ).rejects.toThrow(/Graficas por sucursal/);
  });

  it('un body vacio devuelve todos los modulos a su valor de fabrica', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: {} }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: {} }]);

    const vista = await servicio(query).replacePreferences({});

    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), ['{}']);
    expect(vista.enabled).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('si el trigger de la base lo rechaza responde 403 y no 500', async () => {
    // Pasa cuando el techo cambia entre la lectura y la escritura. La reja de la
    // base es la que manda: no depende de que este metodo la haya consultado.
    const query = jest.fn();
    query
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: {} }])
      .mockRejectedValueOnce(errorDeBase('42501'));

    await expect(
      servicio(query).replacePreferences({ map: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un error de base que no sea de permisos NO se disfraza de 403', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([{ ...PLAN_BASE, flags: {} }])
      .mockRejectedValueOnce(errorDeBase('23505'));

    await expect(servicio(query).replacePreferences({})).rejects.not.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('FeatureFlagsService.overview', () => {
  it('entrega el catalogo junto a lo prendido, para que la app no sepa de memoria los modulos', async () => {
    const query = niveles({ ...PLAN_BASE, flags: {} });
    const vista = await servicio(query).overview();

    expect(vista.modules.length).toBeGreaterThan(0);
    expect(vista.enabled).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(vista.sources.map).toBe('producto');
  });
});
