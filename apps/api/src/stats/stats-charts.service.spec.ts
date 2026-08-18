import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { StatsChartsService } from './stats-charts.service';

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

/** SQL de la n-esima consulta que el servicio mando al motor. */
const sql = (query: jest.Mock, n: number): string => String(query.mock.calls[n]?.[0]);
const params = (query: jest.Mock, n: number): unknown[] => query.mock.calls[n]?.[1] as unknown[];

describe('StatsChartsService — alcance y aislamiento', () => {
  it('nunca recibe el tenant por parametro: lo pone RLS', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(ADMIN, RANGO);

    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toMatch(/tenant_id\s*=\s*\$\d/);
      // El unico tenant que aparece sale de la sesion de PostgreSQL.
      expect(call[1]).not.toContain('admin-id');
    }
  });

  it('para el ADMIN no filtra por recintos asignados', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(ADMIN, RANGO);

    // $3 es el supervisor; en NULL el EXISTS de supervisor_sites se apaga solo.
    expect(params(query, 1)).toEqual(['2026-03-01', '2026-03-31', null, null, null]);
  });

  it('al SUPERVISOR lo encierra en sus recintos asignados', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(SUPERVISOR, RANGO);

    expect(sql(query, 1)).toContain('FROM supervisor_sites ss');
    expect(sql(query, 1)).toContain('ss.supervisor_id = $3::uuid');
    expect(params(query, 1)?.[2]).toBe('supervisor-id');
  });

  it('el filtro de recintos asignados va en TODAS las graficas', async () => {
    for (const grafica of [
      'complianceBySite',
      'evolution',
      'missedCheckpoints',
      'guardRanking',
      'complianceByRoute',
    ] as const) {
      const { service, query } = servicio();
      await service[grafica](SUPERVISOR, RANGO);
      const consultas = query.mock.calls.map((call) => String(call[0]));
      expect(consultas.every((c) => c.includes('supervisor_sites'))).toBe(true);
    }
  });

  it('un SUPERVISOR que pide un recinto ajeno recibe 403, no una grafica vacia', async () => {
    const { service, supervisor } = servicio();
    (supervisor.ensureAssignedSite as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException('No tienes este recinto asignado'),
    );

    await expect(
      service.complianceBySite(SUPERVISOR, { ...RANGO, siteId: 'site-ajeno' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el ADMIN no pasa por la comprobacion de recintos asignados', async () => {
    const { service, supervisor } = servicio();
    await service.complianceBySite(ADMIN, { ...RANGO, siteId: 'site-1' });

    expect(supervisor.ensureAssignedSite).not.toHaveBeenCalled();
  });
});

describe('StatsChartsService — zona horaria', () => {
  it('agrupa por el dia del recinto, no por el del servidor', async () => {
    const { service, query } = servicio();
    await service.missedCheckpoints(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('AT TIME ZONE s.timezone');
    expect(sql(query, 0)).not.toContain("AT TIME ZONE 'UTC'");
  });

  /**
   * La trampa: sumar el dia DESPUES de convertir son 24 horas fijas, y en la
   * noche del cambio de horario el corte del dia se corre una hora.
   */
  it('suma el dia al timestamp sin zona ANTES de convertir', async () => {
    const { service, query } = servicio();
    await service.missedCheckpoints(ADMIN, RANGO);
    await service.guardRanking(ADMIN, RANGO);

    for (const consulta of [sql(query, 0), sql(query, 1)]) {
      expect(consulta).toContain("($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone");
      expect(consulta).not.toMatch(/AT TIME ZONE s\.timezone\)\s*\+\s*INTERVAL/);
    }
  });

  it('el cubo diario ya viene en dia local: semana y mes solo truncan una date', async () => {
    const { service, query } = servicio();
    await service.evolution(ADMIN, { ...RANGO, granularity: 'semana' });

    expect(sql(query, 1)).toContain('date_trunc($6::text, r.service_day::timestamp)::date');
    expect(params(query, 1)?.[5]).toBe('week');
  });

  it('traduce la granularidad al vocabulario de date_trunc', async () => {
    for (const [pedido, esperado] of [
      ['dia', 'day'],
      ['semana', 'week'],
      ['mes', 'month'],
    ] as const) {
      const { service, query } = servicio();
      await service.evolution(ADMIN, { ...RANGO, granularity: pedido });
      expect(params(query, 1)?.[5]).toBe(esperado);
    }
  });
});

describe('StatsChartsService — rangos acotados', () => {
  it('rechaza dos años de la grafica que baja a scans', async () => {
    const { service, query } = servicio();

    await expect(
      service.missedCheckpoints(ADMIN, { from: '2024-01-01', to: '2026-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Y no llego a tocar la base.
    expect(query).not.toHaveBeenCalled();
  });

  it('acepta dos años en las series que se leen del cubo', async () => {
    const { service } = servicio();
    await expect(
      service.evolution(ADMIN, { from: '2024-01-01', to: '2025-12-31' }),
    ).resolves.toMatchObject({ range: { dias: 731 } });
  });

  it('sin rango explicito no consulta desde el inicio de los tiempos', async () => {
    const { service } = servicio();
    const resultado = await service.complianceBySite(ADMIN, {});
    expect(resultado.range.dias).toBe(30);
  });
});

describe('StatsChartsService — forma de la agregacion', () => {
  it('materializa los cubos pendientes antes de leer la serie', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(ADMIN, RANGO);

    // Primero el relleno...
    expect(sql(query, 0)).toContain('app_stats_recompute_range(app_tenant_id()');
    // ...y solo recalcula lo que falta o el dia en curso del recinto.
    expect(sql(query, 0)).toContain("(now() AT TIME ZONE v.timezone)::date");
    expect(sql(query, 0)).toContain('NOT EXISTS');
    // ...despues la lectura.
    expect(sql(query, 1)).toContain('FROM patrol_daily_stats r');
  });

  it('promedia ponderado, no promedio de promedios diarios', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(ADMIN, RANGO);

    expect(sql(query, 1)).toContain('sum(r.compliance_sum) / sum(r.compliance_count)');
    expect(sql(query, 1)).not.toContain('avg(');
  });

  it('las graficas de cumplimiento excluyen las rondas voluntarias y las abiertas', async () => {
    const { service, query } = servicio();
    await service.missedCheckpoints(ADMIN, RANGO);
    await service.guardRanking(ADMIN, RANGO);
    await service.complianceByRoute(ADMIN, RANGO);

    for (const consulta of [sql(query, 0), sql(query, 1), sql(query, 2)]) {
      expect(consulta).toContain('NOT p.is_voluntary');
      expect(consulta).toContain("p.status IN ('completada', 'incompleta', 'vencida')");
    }
  });

  it('cuenta un punto omitido una sola vez aunque se escanee dos veces', async () => {
    const { service, query } = servicio();
    await service.missedCheckpoints(ADMIN, RANGO);

    expect(sql(query, 0)).toContain('EXISTS (');
    expect(sql(query, 0)).toContain('sc.checkpoint_id = punto.checkpoint_id');
    expect(sql(query, 0)).not.toContain('LEFT JOIN scans');
  });

  it('el umbral del ranking sale de las reglas del tenant, no de una constante', async () => {
    const { service, query, rules } = servicio();
    (rules.effective as jest.Mock).mockResolvedValueOnce(
      patrolRulesSchema.parse({ complianceThreshold: 85 }),
    );

    const resultado = await service.guardRanking(ADMIN, RANGO);

    expect(params(query, 0)?.[5]).toBe(85);
    expect(resultado.threshold).toBe(85);
  });

  it('ordena de peor a mejor: el panel se abre a buscar el problema', async () => {
    const { service, query } = servicio();
    await service.complianceBySite(ADMIN, RANGO);
    await service.guardRanking(ADMIN, RANGO);

    expect(sql(query, 1)).toContain('ORDER BY cumplimiento NULLS LAST');
    expect(sql(query, 2)).toContain('ORDER BY cumplimiento NULLS LAST');
  });

  it('mapea las filas del motor al contrato de la grafica', async () => {
    const { service } = servicio([
      [],
      [
        {
          site_id: 'site-1',
          site_name: 'Planta Norte',
          branch_name: 'Casa matriz',
          rondas: '120',
          completadas: '100',
          incompletas: '15',
          vencidas: '5',
          abiertas: '0',
          con_cumplimiento: '120',
          cumplimiento: '64.5',
        },
      ],
    ]);

    const resultado = await service.complianceBySite(ADMIN, RANGO);

    expect(resultado.sites[0]).toEqual({
      siteId: 'site-1',
      siteName: 'Planta Norte',
      branchName: 'Casa matriz',
      patrols: 120,
      completed: 100,
      incomplete: 15,
      expired: 5,
      open: 0,
      ratedPatrols: 120,
      compliancePct: 64.5,
      belowThreshold: true,
    });
    expect(resultado.threshold).toBe(70);
  });

  it('un recinto sin rondas calificadas no arrastra un cero al promedio', async () => {
    const { service } = servicio([
      [],
      [
        {
          site_id: 'site-2',
          site_name: 'Bodega Sur',
          branch_name: 'Sucursal sur',
          rondas: '0',
          completadas: '0',
          incompletas: '0',
          vencidas: '0',
          abiertas: '0',
          con_cumplimiento: '0',
          cumplimiento: null,
        },
      ],
    ]);

    const resultado = await service.complianceBySite(ADMIN, RANGO);

    expect(resultado.sites[0]?.compliancePct).toBeNull();
    expect(resultado.sites[0]?.belowThreshold).toBe(false);
  });
});
