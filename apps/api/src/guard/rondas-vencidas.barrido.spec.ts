import { patrolRulesSchema } from '@sentrycore/shared';
import type { DataSource } from 'typeorm';

import type { RulesService } from '../rules/rules.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { BarridoVencidasService } from './rondas-vencidas.barrido';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * El barrido de rondas abandonadas.
 *
 * Lo que vigila esto: que el barrido NO decida por su cuenta. La consulta
 * cruza-tenant devuelve candidatas con un tope grueso, y quien vence de verdad
 * es `rondaVencida()` con las reglas del RECINTO de cada ronda. Si el barrido
 * venciera por su cuenta, le cerraria el turno a un guardia que esta trabajando
 * en un recinto con duracion maxima alta.
 */
function servicio(opciones: {
  candidatas: Array<{ tenant_id: string; patrol_id: string }>;
  ronda: Record<string, unknown> | null;
  reglas?: Partial<ReturnType<typeof patrolRulesSchema.parse>>;
}) {
  const enTenant = jest.fn();
  const queryDelTenant = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM patrols')) return Promise.resolve(opciones.ronda ? [opciones.ronda] : []);
    return Promise.resolve([]);
  });

  const dataSource = {
    query: jest.fn().mockResolvedValue(opciones.candidatas),
    createQueryRunner: () => ({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: { query: jest.fn() },
    }),
  } as unknown as DataSource;

  const tenantContext = {
    // `run` ejecuta la operacion tal cual: lo que importa aqui es la decision,
    // no el mecanismo de la transaccion (ese se copia del worker de informes).
    run: jest.fn(
      (_runner: unknown, _tenantId: string, operacion: () => Promise<unknown>) =>
        operacion(),
    ),
    transactionCommitted: jest.fn().mockResolvedValue(undefined),
    transactionRolledBack: jest.fn(),
    manager: { query: queryDelTenant },
  } as unknown as TenantContextService;

  const rules = {
    effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse(opciones.reglas ?? {})),
  } as unknown as RulesService;

  const agenda = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };

  return {
    servicio: new BarridoVencidasService(agenda as never, dataSource, tenantContext, rules),
    dataSource,
    tenantContext,
    queryDelTenant,
    rules,
    agenda,
    enTenant,
  };
}

const HACE_48_HORAS = new Date(Date.now() - 48 * 3_600_000);

describe('BarridoVencidasService', () => {
  it('vence la ronda abandonada que ninguna regla del recinto mantiene viva', async () => {
    // El caso real: una ronda de un turno de hace dos dias que nadie volvio a
    // tocar. Sin este barrido se queda `en_curso` para siempre y las alertas de
    // escalamiento sobre 'vencida' no disparan nunca.
    const { servicio: barrido, queryDelTenant } = servicio({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: 'patrol-1' }],
      ronda: {
        status: 'en_curso',
        started_at: HACE_48_HORAS,
        scheduled_end_at: HACE_48_HORAS,
        site_id: 'site-1',
      },
    });

    await expect(barrido.barrer()).resolves.toEqual({
      candidatas: 1,
      vencidas: 1,
      aunVivas: 0,
    });
    const update = queryDelTenant.mock.calls.find(([sql]: [string]) =>
      sql.includes("SET status = 'vencida'"),
    );
    expect(update).toBeDefined();
    // El WHERE repite el estado: entre el SELECT y el UPDATE el guardia pudo
    // cerrar la ronda, y pisar una 'completada' borraria un cierre legitimo.
    expect(update?.[0]).toContain("status IN ('pendiente', 'en_curso')");
  });

  it('NO pisa la ronda que el guardia cerro entre la consulta y el veredicto', async () => {
    /*
     * LA CARRERA REAL, y el motivo de que el veredicto se tome adentro de la
     * transaccion y no en el SQL cruza-tenant: entre que el barrido lista las
     * candidatas y que llega a esta ronda, el guardia pudo terminarla. Pisar una
     * 'completada' con 'vencida' borraria un cierre legitimo — y con el, el
     * cumplimiento que ya se informo.
     *
     * `rondaVencida()` devuelve false para todo estado cerrado, asi que la ronda
     * cuenta como "aun viva" y no se toca. El UPDATE ademas repite el estado en
     * su WHERE: son dos cerrojos para el mismo dedo.
     *
     * (El otro caso que imagine —un recinto con reglas mas permisivas— no puede
     * ocurrir: la gracia del SQL son 25 h y el maximo que la regla admite son
     * 24, asi que toda candidata vence. Esa holgura es deliberada: el filtro
     * grueso nunca debe vencer de menos.)
     */
    const { servicio: barrido, queryDelTenant, rules } = servicio({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: 'patrol-1' }],
      ronda: {
        status: 'completada',
        started_at: HACE_48_HORAS,
        scheduled_end_at: HACE_48_HORAS,
        site_id: 'site-1',
      },
    });

    await expect(barrido.barrer()).resolves.toMatchObject({ vencidas: 0, aunVivas: 1 });
    expect(
      queryDelTenant.mock.calls.some(([sql]: [string]) => sql.includes("'vencida'")),
    ).toBe(false);
    // Y las reglas se piden con el RECINTO de la ronda, no las del tenant a
    // secas: la cascada se corta si no se pasa el sitio.
    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-1' });
  });

  it('una ronda que fallo no detiene el barrido: la proxima pasada la reencuentra', async () => {
    const { servicio: barrido, queryDelTenant, tenantContext } = servicio({
      candidatas: [
        { tenant_id: TENANT_A, patrol_id: 'patrol-1' },
        { tenant_id: TENANT_B, patrol_id: 'patrol-2' },
      ],
      ronda: {
        status: 'en_curso',
        started_at: HACE_48_HORAS,
        scheduled_end_at: HACE_48_HORAS,
        site_id: 'site-1',
      },
    });
    queryDelTenant.mockImplementationOnce(() => Promise.reject(new Error('conexion caida')));

    // No lanza: el fallo de una ronda se registra y el barrido sigue.
    await expect(barrido.barrer()).resolves.toMatchObject({ candidatas: 2, vencidas: 1 });
    expect(tenantContext.run).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      TENANT_A,
      expect.any(Function),
    );
    expect(tenantContext.run).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      TENANT_B,
      expect.any(Function),
    );
  });

  it('sin candidatas no toca la base de ningun tenant', async () => {
    const { servicio: barrido, queryDelTenant } = servicio({ candidatas: [], ronda: null });

    await expect(barrido.barrer()).resolves.toEqual({
      candidatas: 0,
      vencidas: 0,
      aunVivas: 0,
    });
    expect(queryDelTenant).not.toHaveBeenCalled();
  });

  it('programa UN solo scheduler, idempotente entre replicas', () => {
    const { servicio: barrido, agenda } = servicio({ candidatas: [], ronda: null });

    barrido.onModuleInit();

    // `upsertJobScheduler` y no `add({ repeat })`: con varias replicas de la API
    // todas ejecutan onModuleInit y el segundo patron sumaba una entrada
    // repetible por arranque.
    expect(agenda.upsertJobScheduler).toHaveBeenCalledWith(
      'patrol-expiry-sweep',
      { every: 15 * 60_000 },
      expect.objectContaining({ name: 'sweep' }),
    );
  });
});
