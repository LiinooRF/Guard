import { ForbiddenException, Logger } from '@nestjs/common';
import { DEFAULT_PATROL_RULES } from '@sentrycore/shared';
import { QueryFailedError, type DataSource } from 'typeorm';

import { PlatformRulesService } from './platform-rules.service';

const ACTOR = '11111111-1111-4111-8111-111111111111';

/** DataSource falso: `query` para las lecturas y `transaction` para el upsert. */
const fuente = (query: jest.Mock) =>
  ({
    query,
    transaction: (operacion: (manager: { query: jest.Mock }) => Promise<unknown>) =>
      operacion({ query }),
  }) as unknown as DataSource;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('PlatformRulesService.view', () => {
  it('sin overrides devuelve los defaults del producto', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      { overrides: {}, updated_at: new Date('2026-01-01T00:00:00Z'), updated_by: null },
    ]);

    const vista = await new PlatformRulesService(fuente(query)).view();

    expect(vista.scope).toBe('platform');
    expect(vista.effective).toEqual(DEFAULT_PATROL_RULES);
    expect(vista.overrides).toEqual({});
    expect(vista.sources.complianceThreshold).toBe('default');
  });

  it('el override de plataforma cambia el default de TODAS las empresas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { overrides: { complianceThreshold: 85 }, updated_at: new Date(), updated_by: ACTOR },
      ]);

    const vista = await new PlatformRulesService(fuente(query)).view();

    expect(vista.effective.complianceThreshold).toBe(85);
    expect(vista.sources.complianceThreshold).toBe('platform');
    expect(vista.updatedBy).toBe(ACTOR);
  });

  it('descarta lo que no se configura a nivel plataforma y no rompe', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        // Destinatarios globales: recibirian los informes de todas las empresas.
        overrides: { reportRecipients: ['alguien@ejemplo.cl'], complianceThreshold: 80 },
        updated_at: new Date(),
        updated_by: ACTOR,
      },
    ]);

    const vista = await new PlatformRulesService(fuente(query)).view();

    expect(vista.effective.reportRecipients).toEqual([]);
    expect(vista.effective.complianceThreshold).toBe(80);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('regla_fuera_de_nivel_descartada'),
    );
  });

  it('sin fila en la tabla igual responde con los defaults', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(new PlatformRulesService(fuente(query)).view()).resolves.toMatchObject({
      effective: DEFAULT_PATROL_RULES,
      overrides: {},
      updatedAt: null,
    });
  });
});

describe('PlatformRulesService.replace', () => {
  it('escribe por la funcion con control de SUPERADMIN, no con un UPDATE suelto', async () => {
    const query = jest.fn();
    query
      .mockResolvedValueOnce([]) // set_config del actor
      .mockResolvedValueOnce([]) // platform_set_rules
      .mockResolvedValueOnce([
        { overrides: { complianceThreshold: 85 }, updated_at: new Date(), updated_by: ACTOR },
      ]);

    const vista = await new PlatformRulesService(fuente(query)).replace(ACTOR, {
      complianceThreshold: 85,
    });

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("set_config('app.user_id'"), [
      ACTOR,
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('platform_set_rules'), [
      ACTOR,
      JSON.stringify({ complianceThreshold: 85 }),
    ]);
    expect(vista.effective.complianceThreshold).toBe(85);
  });

  it('si la base rechaza al actor responde 403 y no 500', async () => {
    const denegado = new QueryFailedError('select', [], new Error('platform access denied'));
    (denegado as unknown as { driverError: { code: string } }).driverError = { code: '42501' };
    const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(denegado);

    await expect(
      new PlatformRulesService(fuente(query)).replace(ACTOR, { complianceThreshold: 85 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
