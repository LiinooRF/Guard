import { ForbiddenException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import { describeChange, describeValue, parameterCard } from './config-audit.catalog';
import { ConfigAuditService } from './config-audit.service';
import { PlatformConfigAuditService } from './platform-config-audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

const ctx = (query: jest.Mock) => ({ manager: { query } }) as unknown as TenantContextService;

/**
 * DataSource falso con `transaction`, que es como el servicio de plataforma lee
 * de verdad. Un doble con solo `query` dejaba pasar el defecto que importa: sin
 * transaccion propia no hay `app.user_id` seteado, y assert_platform_superadmin
 * rechaza hasta al SUPERADMIN legitimo. Copiado de
 * feature-flags-platform.service.spec.ts.
 */
const fuente = (query: jest.Mock) =>
  ({
    query,
    transaction: (operacion: (manager: { query: jest.Mock }) => Promise<unknown>) =>
      operacion({ query }),
  }) as unknown as DataSource;

/**
 * Lo que estos tests SI pueden probar es el SQL que se arma y como se traduce
 * cada valor. Lo que NO pueden probar es que ese SQL corra: el mock contesta lo
 * que le digan. Por eso ademas hay un test que compara los nombres de columna
 * contra el TEXTO de la migracion (config-audit.migration.spec.ts) y por eso el
 * humo e2e contra la API desplegada sigue siendo obligatorio.
 */
describe('ConfigAuditService', () => {
  it('responde "quien bajo el umbral al 40% el mes pasado"', async () => {
    const query = jest
      .fn()
      // 1) resolucion de la zona horaria   2) el historial
      .mockResolvedValueOnce([{ zona: 'America/Santiago' }])
      .mockResolvedValueOnce([
        {
          id: 'c1',
          area: 'reglas',
          scope: 'tenant',
          target_id: null,
          param_key: 'complianceThreshold',
          old_value: 70,
          new_value: 40,
          actor_id: 'u1',
          actor_label: 'Ana Admin',
          support_access_id: null,
          changed_at: new Date('2026-07-14T18:20:00Z'),
          site_name: null,
          checkpoint_name: null,
        },
      ]);

    const resultado = await new ConfigAuditService(ctx(query)).history({
      paramKey: 'complianceThreshold',
      newValue: '40',
      direction: 'bajo',
      fromDay: '2026-07-01',
      toDay: '2026-07-31',
    });

    const [sql, valores] = query.mock.calls[1];
    expect(sql).toContain('cambio.param_key = $1');
    expect(sql).toMatch(/cambio\.new_value = \$\d+::jsonb/);
    expect(sql).toContain("jsonb_typeof(cambio.old_value) = 'number'");
    expect(sql).toContain("< (cambio.old_value #>> '{}')::numeric");
    // El 40 viaja como numero jsonb y no como el texto "40".
    expect(valores).toEqual([
      'complianceThreshold',
      '2026-07-01',
      'America/Santiago',
      '2026-07-31',
      'America/Santiago',
      '40',
      100,
    ]);

    // Quien, cuando, cuanto valia y cuanto vale: los cuatro datos del issue.
    expect(resultado.changes[0]?.actorLabel).toBe('Ana Admin');
    expect(resultado.changes[0]?.oldLabel).toBe('70%');
    expect(resultado.changes[0]?.newLabel).toBe('40%');
    expect(resultado.changes[0]?.summary).toBe('Umbral de cumplimiento: 70% -> 40%');
    expect(resultado.timeZone).toBe('America/Santiago');
  });

  it('el dia se suma al timestamp SIN zona y recien despues se convierte', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ zona: 'America/Santiago' }])
      .mockResolvedValueOnce([]);

    await new ConfigAuditService(ctx(query)).history({
      fromDay: '2026-07-01',
      toDay: '2026-07-31',
    });

    const [sql] = query.mock.calls[1];
    expect(sql).toContain('::date::timestamp AT TIME ZONE');
    // Sumar el dia DESPUES de convertir corre el rango una hora en el cambio de
    // horario. Es exactamente lo que no puede pasar.
    expect(sql).toContain("::date::timestamp + INTERVAL '1 day') AT TIME ZONE");
    // Limite superior exclusivo: asi el ultimo dia entra entero.
    expect(sql).toContain('cambio.changed_at < (');
  });

  it('la zona horaria sale de los recintos, no de una constante escrita a mano', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ zona: 'Pacific/Easter' }])
      .mockResolvedValueOnce([]);

    const resultado = await new ConfigAuditService(ctx(query)).history({ fromDay: '2026-07-01' });

    const [sqlZona, valoresZona] = query.mock.calls[0];
    expect(sqlZona).toContain('recinto.timezone');
    expect(sqlZona).toContain('FROM sites recinto');
    // Una zona pedida que Postgres no conoce no revienta la consulta.
    expect(sqlZona).toContain('pg_timezone_names');
    expect(valoresZona).toEqual([null, null]);
    expect(resultado.timeZone).toBe('Pacific/Easter');
  });

  it('sin filtro por dias no se resuelve zona: una consulta y no dos', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const resultado = await new ConfigAuditService(ctx(query)).history({ limit: 10 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(resultado.timeZone).toBeNull();
  });

  it('el limite se topa en 500 aunque pidan mas', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ConfigAuditService(ctx(query)).history({ limit: 100000 });
    expect(query.mock.calls[0][1]).toEqual([500]);
  });

  it('los filtros viajan como parametros, nunca concatenados', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ConfigAuditService(ctx(query)).history({
      actorId: '11111111-1111-1111-1111-111111111111',
      paramKey: 'gpsTrackingEnabled',
      newValue: 'false',
    });
    const [sql, valores] = query.mock.calls[0];
    expect(sql).toContain('cambio.param_key = $1');
    expect(sql).toContain('cambio.actor_id = $2::uuid');
    expect(sql).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(valores).toEqual([
      'gpsTrackingEnabled',
      '11111111-1111-1111-1111-111111111111',
      'false',
      100,
    ]);
  });

  it('un valor de texto se busca como texto y uno numerico como numero', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ConfigAuditService(ctx(query));

    await service.history({ newValue: '40' });
    expect(query.mock.calls[0][1][0]).toBe('40');

    await service.history({ newValue: 'alta' });
    expect(query.mock.calls[1][1][0]).toBe('"alta"');
  });

  it('el historial no filtra por tenant a mano: eso lo hace la politica RLS', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ConfigAuditService(ctx(query)).history({});
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('FROM config_change_log cambio');
    // Un WHERE tenant_id = ... aca seria un filtro que se puede olvidar. El
    // aislamiento vive en la politica de la tabla.
    expect(sql).not.toContain('cambio.tenant_id =');
  });

  it('distingue el cambio hecho por soporte de la plataforma', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'c2',
        area: 'reglas',
        scope: 'site',
        target_id: 's1',
        param_key: 'gpsValidationRadiusM',
        old_value: 50,
        new_value: 200,
        actor_id: 'sa1',
        actor_label: 'Soporte VoxIA',
        support_access_id: 'ventana-1',
        changed_at: new Date('2026-07-02T10:00:00Z'),
        site_name: 'Bodega Sur',
        checkpoint_name: null,
      },
    ]);
    const { changes } = await new ConfigAuditService(ctx(query)).history({});
    expect(changes[0]?.viaSupportAccess).toBe(true);
    expect(changes[0]?.targetName).toBe('Bodega Sur');
    expect(changes[0]?.scopeLabel).toBe('Recinto');
    expect(changes[0]?.summary).toBe('Radio de validacion del escaneo: 50 m -> 200 m');
  });

  it('el resumen por parametro agrupa y trae el ultimo cambio', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        area: 'reglas',
        param_key: 'complianceThreshold',
        cambios: '3',
        ultimo: new Date('2026-07-14T18:20:00Z'),
        ultimo_actor: 'Ana Admin',
        ultimo_anterior: 70,
        ultimo_nuevo: 40,
      },
    ]);
    const resumen = await new ConfigAuditService(ctx(query)).parameters('reglas');
    const [sql, valores] = query.mock.calls[0];
    expect(sql).toContain('GROUP BY cambio.area, cambio.param_key');
    expect(valores).toEqual(['reglas']);
    expect(resumen[0]?.changes).toBe(3);
    expect(resumen[0]?.lastActorLabel).toBe('Ana Admin');
    expect(resumen[0]?.lastSummary).toBe('Umbral de cumplimiento: 70% -> 40%');
  });
});

describe('traduccion de valores del historial', () => {
  it('sin valor significa "hereda", que no es lo mismo que apagado', () => {
    expect(describeValue(null, null)).toBe('sin definir (hereda)');
    expect(describeValue(false, null)).toBe('no');
  });

  it('gpsSharingRequired se lee como obligatorio, no como interruptor', () => {
    // La regla decide OBLIGATORIO vs OPCIONAL. Ponerla en "no" no significa que
    // se deje de registrar la ubicacion: eso lo decide gpsTrackingEnabled. El
    // texto sale del catalogo justamente para que nadie lo lea al reves.
    expect(describeChange('reglas', 'gpsSharingRequired', true, false).summary).toBe(
      'Exigir permiso de ubicacion: si -> no',
    );
    expect(describeChange('reglas', 'gpsTrackingEnabled', true, false).summary).toBe(
      'Registrar el recorrido: si -> no',
    );
  });

  it('las listas se muestran completas y las vacias se dicen', () => {
    expect(
      describeChange('reglas', 'escalationCriticalities', ['alta', 'panico'], []).summary,
    ).toBe('Criticidades que escalan: alta, panico -> ninguno');
  });

  it('un modulo usa la ficha del catalogo de modulos', () => {
    expect(parameterCard('modulos', 'map')?.label).toBe('Mapa en vivo');
    expect(describeChange('licencia', 'map', true, false).summary).toBe('Mapa en vivo: si -> no');
  });

  it('una clave desconocida se muestra igual, sin inventarle ficha', () => {
    const cambio = describeChange('reglas', 'parametroQueYaNoExiste', 1, 2);
    expect(cambio.card).toBeNull();
    expect(cambio.summary).toBe('parametroQueYaNoExiste: 1 -> 2');
  });
});

describe('PlatformConfigAuditService', () => {
  const ACTOR = '11111111-1111-4111-8111-111111111111';

  it('declara el actor en la conexion ANTES de llamar a la funcion', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformConfigAuditService(fuente(query)).tenantHistory(
      ACTOR,
      '22222222-2222-2222-2222-222222222222',
      { limit: 20 },
    );

    // assert_platform_superadmin exige actor_id = app_user_id(). Sin esta
    // primera consulta, app_user_id() es NULL y la funcion devuelve 42501
    // incluso para un SUPERADMIN valido: el endpoint seria un 403 permanente.
    const [sqlContexto, valoresContexto] = query.mock.calls[0];
    expect(sqlContexto).toContain("set_config('app.user_id'");
    // El tercer parametro en true es SET LOCAL: no queda pegado al pool.
    expect(sqlContexto).toContain('true');
    expect(valoresContexto).toEqual([ACTOR]);
    // Nunca app.tenant_id: la plataforma no se fabrica contexto de una empresa.
    expect(query.mock.calls.map(([sql]: [string]) => sql).join(' ')).not.toContain(
      'app.tenant_id',
    );
  });

  it('lee por la funcion de plataforma y no por la tabla', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformConfigAuditService(fuente(query)).tenantHistory(
      ACTOR,
      '22222222-2222-2222-2222-222222222222',
      { limit: 20 },
    );
    const [sql, valores] = query.mock.calls[1];
    expect(sql).toContain('platform_config_history(');
    expect(sql).not.toContain('FROM config_change_log');
    expect(valores[0]).toBe(ACTOR);
    expect(valores[6]).toBe(20);
  });

  it('el historial de plataforma tambien declara su actor', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new PlatformConfigAuditService(fuente(query)).platformHistory(ACTOR, { limit: 20 });

    expect(query.mock.calls[0][0]).toContain("set_config('app.user_id'");
    expect(query.mock.calls[0][1]).toEqual([ACTOR]);
    const [sql, valores] = query.mock.calls[1];
    expect(sql).toContain('platform_rules_history(');
    expect(valores[0]).toBe(ACTOR);
  });

  it('un rechazo de la base es 403 y no 500', async () => {
    const query = jest
      .fn()
      // El contexto se setea sin problema; lo que rechaza es la funcion, que es
      // donde vive assert_platform_superadmin.
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new QueryFailedError('select', [], { code: '42501' } as unknown as Error),
      );

    await expect(
      new PlatformConfigAuditService(fuente(query)).platformHistory('intruso', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
