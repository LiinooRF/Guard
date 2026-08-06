import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { StatsChartsService } from './stats-charts.service';

/**
 * Cumplimiento por ruta (#99).
 *
 * Spec aparte de `stats-charts.service.spec.ts` porque esta grafica nacio para
 * reemplazar una cuenta que se hacia en el navegador, y lo que hay que fijar es
 * justamente lo que alla no se podia: que agrupe por ID de ruta, que descarte
 * las rondas abiertas y las voluntarias, y que el corte del periodo lo haga el
 * motor con la zona del recinto.
 *
 * Ojo con lo que estas pruebas SI y NO demuestran: el mock devuelve lo que se le
 * pide, asi que esto verifica el SQL que se manda y el mapeo de la respuesta, no
 * que PostgreSQL devuelva esas filas. Los nombres de columna estan comprobados
 * contra las migraciones 1722524400000 (`routes`, `patrols`, `sites`) y
 * 1724252400000 (`patrols.is_voluntary`), no contra este mock.
 */

const ADMIN = { userId: 'admin-id', role: 'ADMIN' } as const;
const SUPERVISOR = { userId: 'supervisor-id', role: 'SUPERVISOR' } as const;
const RANGO = { from: '2026-03-01', to: '2026-03-31' };

function servicio(filas: unknown[][] = []) {
  const query = jest.fn();
  for (const fila of filas) query.mockResolvedValueOnce(fila);
  query.mockResolvedValue([]);

  const rules = {
    effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})),
  } as unknown as RulesService;
  const supervisor = {
    ensureAssignedSite: jest.fn().mockResolvedValue(undefined),
  } as unknown as SupervisorService;

  const service = new StatsChartsService(
    { manager: { query } } as unknown as TenantContextService,
    rules,
    supervisor,
  );
  return { service, query, rules, supervisor };
}

const sql = (query: jest.Mock, n: number): string => String(query.mock.calls[n]?.[0]);
const params = (query: jest.Mock, n: number): unknown[] => query.mock.calls[n]?.[1] as unknown[];

/** Una fila del motor, con los tipos de texto que devuelve el driver de pg. */
function fila(extra: Record<string, unknown> = {}) {
  return {
    route_id: 'ruta-1',
    route_name: 'Perímetro noche',
    site_id: 'site-1',
    site_name: 'Planta Norte',
    branch_name: 'Casa matriz',
    duracion_estimada_min: '45',
    rondas: '40',
    completadas: '10',
    incompletas: '25',
    vencidas: '5',
    guardias: '6',
    con_cumplimiento: '40',
    cumplimiento: '52.4',
    bajo_umbral: '31',
    duracion_real_min: '61.5',
    duracion_muestra: '10',
    ...extra,
  };
}

describe('complianceByRoute — lo que no se podia hacer en el navegador', () => {
  it('agrupa por ID de ruta y no por nombre', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('JOIN routes rt ON rt.tenant_id = p.tenant_id');
    expect(sql(query, 0)).toContain('GROUP BY rt.id');
    // Agrupar por el nombre es exactamente el bug que esta consulta viene a
    // cerrar: dos rutas distintas llamadas igual daban una sola fila.
    expect(sql(query, 0)).not.toMatch(/GROUP BY[^)]*rt\.name,\s*rt\.id/);
  });

  it('descarta las rondas voluntarias y las que todavia no terminan', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('NOT p.is_voluntary');
    expect(sql(query, 0)).toContain("p.status IN ('completada', 'incompleta', 'vencida')");
  });

  it('corta el periodo con la zona del recinto, sumando el dia antes de convertir', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('($1::date::timestamp AT TIME ZONE s.timezone)');
    expect(sql(query, 0)).toContain(
      "($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone",
    );
    expect(sql(query, 0)).not.toMatch(/AT TIME ZONE s\.timezone\)\s*\+\s*INTERVAL/);
  });

  it('no lee el cubo diario: una sola consulta y en vivo sobre patrols', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(query).toHaveBeenCalledTimes(1);
    expect(sql(query, 0)).toContain('FROM patrols p');
    expect(sql(query, 0)).not.toContain('patrol_daily_stats');
  });
});

describe('complianceByRoute — alcance', () => {
  it('encierra al SUPERVISOR en sus recintos asignados', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(SUPERVISOR, RANGO);

    expect(sql(query, 0)).toContain('FROM supervisor_sites ss');
    expect(sql(query, 0)).toContain('ss.supervisor_id = $3::uuid');
    expect(params(query, 0)?.[2]).toBe('supervisor-id');
  });

  it('para el ADMIN el filtro de recintos queda apagado', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(params(query, 0)?.[2]).toBeNull();
  });

  it('un SUPERVISOR que pide un recinto ajeno recibe 403, no una tabla vacia', async () => {
    const { service, supervisor, query } = servicio();
    (supervisor.ensureAssignedSite as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException('No tienes este recinto asignado'),
    );

    await expect(
      service.complianceByRoute(SUPERVISOR, { ...RANGO, siteId: 'site-ajeno' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });

  it('nunca recibe el tenant por parametro: lo pone RLS', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(SUPERVISOR, RANGO);

    expect(sql(query, 0)).not.toMatch(/tenant_id\s*=\s*\$\d/);
  });
});

describe('complianceByRoute — rango y umbral', () => {
  it('rechaza mas de un año y no llega a tocar la base', async () => {
    const { service, query } = servicio();

    await expect(
      service.complianceByRoute(ADMIN, { from: '2024-01-01', to: '2026-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('acepta un año completo, que es el tope del ranking', async () => {
    const { service } = servicio();
    await expect(
      service.complianceByRoute(ADMIN, { from: '2025-01-01', to: '2025-12-31' }),
    ).resolves.toMatchObject({ range: { dias: 365 } });
  });

  it('el umbral sale de las reglas del tenant, no de una constante', async () => {
    const { service, query, rules } = servicio();
    (rules.effective as jest.Mock).mockResolvedValueOnce(
      patrolRulesSchema.parse({ complianceThreshold: 85 }),
    );

    const resultado = await service.complianceByRoute(ADMIN, RANGO);

    expect(params(query, 0)?.[5]).toBe(85);
    expect(resultado.threshold).toBe(85);
  });

  it('ordena de peor a mejor: al panel se entra a buscar el problema', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('ORDER BY cumplimiento NULLS LAST');
  });
});

describe('complianceByRoute — contrato de la respuesta', () => {
  it('mapea la fila del motor al contrato de la tarjeta', async () => {
    const { service } = servicio([[fila()]]);

    const resultado = await service.complianceByRoute(ADMIN, RANGO);

    expect(resultado.routes[0]).toEqual({
      routeId: 'ruta-1',
      routeName: 'Perímetro noche',
      siteId: 'site-1',
      siteName: 'Planta Norte',
      branchName: 'Casa matriz',
      patrols: 40,
      completed: 10,
      incomplete: 25,
      expired: 5,
      guards: 6,
      ratedPatrols: 40,
      compliancePct: 52.4,
      belowThreshold: 31,
      estimatedDurationMin: 45,
      avgDurationMin: 61.5,
      durationSamples: 10,
    });
    expect(resultado.threshold).toBe(70);
  });

  it('una ruta sin ninguna ronda calificada no arrastra un cero al promedio', async () => {
    const { service } = servicio([
      [fila({ cumplimiento: null, con_cumplimiento: '0', bajo_umbral: '0' })],
    ]);

    const resultado = await service.complianceByRoute(ADMIN, RANGO);

    expect(resultado.routes[0]?.compliancePct).toBeNull();
    expect(resultado.routes[0]?.belowThreshold).toBe(0);
  });

  it('una ruta cuyas rondas nunca se abrieron no inventa una duracion real', async () => {
    const { service } = servicio([
      [fila({ duracion_real_min: null, duracion_muestra: '0' })],
    ]);

    const resultado = await service.complianceByRoute(ADMIN, RANGO);

    // `closed_at - started_at` es NULL si la ronda vencio sin iniciarse. Un 0
    // ahi se leeria como "la hacen en un instante", que es lo contrario.
    expect(resultado.routes[0]?.avgDurationMin).toBeNull();
    expect(resultado.routes[0]?.durationSamples).toBe(0);
    expect(resultado.routes[0]?.estimatedDurationMin).toBe(45);
  });
});

describe('complianceByRoute — la duracion, que es lo que dice si la ruta cabe', () => {
  it('promedia SOLO las rondas completas, y dice sobre cuantas', async () => {
    // Una ronda incompleta o vencida se abandono a medio camino: su duracion
    // mide hasta donde se llego, no cuanto toma la ruta. Promediada junto a las
    // demas ACORTA el numero justo en las rutas que peor cumplen, o sea tapa el
    // problema exactamente donde hay que verlo. Por eso el promedio va filtrado
    // y viaja con su propio tamaño de muestra.
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain("FILTER (WHERE p.status = 'completada')");
    expect(sql(query, 0)).toContain('AS duracion_muestra');
    // El promedio de CUMPLIMIENTO no lleva ese filtro: ahi las tres cuentan,
    // igual que en el resto del panel.
    expect(sql(query, 0)).toContain('round(avg(p.compliance_pct), 1)');
  });

  it('redondea la duracion como numeric: round(double precision, int) no existe', async () => {
    // EXTRACT devolvia double precision antes de PostgreSQL 14, y una funcion
    // que no existe se descubre al EVALUAR la consulta, no al desplegarla: con
    // toda la CI en verde. El cast es lo unico que lo evita.
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('EXTRACT(EPOCH FROM (p.closed_at - p.started_at))::numeric');
  });

  it('la duracion estimada sale de la ruta, no de una constante del codigo', async () => {
    const { service, query } = servicio();
    await service.complianceByRoute(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('rt.estimated_duration_min AS duracion_estimada_min');
  });
});
