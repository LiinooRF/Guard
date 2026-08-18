import { ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { TrazaMetricasService } from './traza-metricas.service';

/**
 * Los mocks devuelven ARREGLOS DE FILAS planos, y eso es correcto aca porque
 * todas las consultas de este servicio son SELECT. Si alguna vez se agrega un
 * UPDATE, el driver devuelve `[filas, rowCount]` y el mock tendria que imitar
 * eso; hay un test mas abajo que vigila justamente que no aparezca ninguno.
 */
const reglas = (overrides: Record<string, unknown> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({ ...patrolRulesSchema.parse({}), ...overrides }),
  }) as unknown as RulesService;

function servicio(
  query: jest.Mock,
  opciones: { ensure?: jest.Mock; overrides?: Record<string, unknown> } = {},
) {
  const ensure = opciones.ensure ?? jest.fn();
  const service = new TrazaMetricasService(
    { manager: { query } } as unknown as TenantContextService,
    reglas(opciones.overrides),
    { ensureAssignedSite: ensure } as unknown as SupervisorService,
  );
  return { service, ensure };
}

const ADMIN = { sub: 'user-1', role: 'ADMIN' as const };
const SUPERVISOR = { sub: 'user-2', role: 'SUPERVISOR' as const };

const T0 = new Date('2026-08-02T02:00:00Z').getTime();
const en = (minuto: number) => new Date(T0 + minuto * 60_000);

const RONDA = {
  id: 'patrol-1',
  site_id: 'site-1',
  guard_id: 'guard-1',
  status: 'completada',
  started_at: en(0),
  closed_at: en(30),
};

/** Fila de patrol_tracks tal como la entrega el driver: numeric como string. */
const punto = (minuto: number, norte: number, patrolId?: string) => ({
  ...(patrolId ? { patrol_id: patrolId } : {}),
  recorded_at_device: en(minuto),
  latitude: (-33.45 + norte * 0.0009).toFixed(6),
  longitude: '-70.660000',
  accuracy_m: '9.00',
  battery_pct: 80,
});

const sqlDe = (query: jest.Mock): string[] => query.mock.calls.map(([sql]: [string]) => sql);

describe('TrazaMetricasService — traza de una ronda (#134)', () => {
  it('devuelve distancia, huecos y tiempo detenido de la ronda', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([punto(0, 0), punto(1, 1), punto(2, 2)]);

    const { service } = servicio(query);
    const salida = await service.patrolTrackSummary('patrol-1', ADMIN);

    expect(salida.patrolId).toBe('patrol-1');
    expect(salida.siteId).toBe('site-1');
    expect(salida.points).toBe(3);
    expect(salida.distanceM).toBeGreaterThan(150);
    // La ronda cerro a los 30 minutos y la traza muere en el minuto 2: eso es un
    // hueco de cola de 28 minutos, no una ronda perfecta.
    expect(salida.gapCount).toBe(1);
    expect(salida.gaps[0]?.toAt).toEqual(en(30));
    expect(salida.thresholds.maxAccuracyM).toBe(100);
  });

  it('pide los puntos ordenados por instante del dispositivo', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await service.patrolTrackSummary('patrol-1', ADMIN);

    const consulta = sqlDe(query).find((sql) => sql.includes('FROM patrol_tracks'));
    expect(consulta).toContain('ORDER BY recorded_at_device');
    // Columnas verificadas contra 1724511600000-CreateTrackAndConsent.
    expect(consulta).toContain('accuracy_m');
    expect(consulta).toContain('battery_pct');
  });

  it('una ronda inexistente es 404 y no consulta la traza', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await expect(service.patrolTrackSummary('patrol-1', ADMIN)).rejects.toThrow(
      'La ronda no existe',
    );
    expect(sqlDe(query).some((sql) => sql.includes('patrol_tracks'))).toBe(false);
  });

  it('el SUPERVISOR sin el recinto asignado no ve la traza', async () => {
    const ensure = jest.fn().mockRejectedValue(new ForbiddenException('No tienes este recinto asignado'));
    const query = jest.fn().mockResolvedValueOnce([RONDA]);

    const { service } = servicio(query, { ensure });
    await expect(service.patrolTrackSummary('patrol-1', SUPERVISOR)).rejects.toThrow(
      'No tienes este recinto asignado',
    );
    expect(ensure).toHaveBeenCalledWith('site-1', 'user-2');
    expect(sqlDe(query).some((sql) => sql.includes('patrol_tracks'))).toBe(false);
  });

  it('el ADMIN no pasa por la restriccion de recintos asignados', async () => {
    const ensure = jest.fn();
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);

    const { service } = servicio(query, { ensure });
    await service.patrolTrackSummary('patrol-1', ADMIN);

    expect(ensure).not.toHaveBeenCalled();
  });

  it('no escribe: todas sus consultas son de lectura', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await service.patrolTrackSummary('patrol-1', ADMIN);

    for (const sql of sqlDe(query)) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });
});

describe('TrazaMetricasService — umbrales aplicados (#134)', () => {
  const conReglas = async (overrides: Record<string, unknown>) => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);
    const { service } = servicio(query, { overrides });
    return (await service.patrolTrackSummary('patrol-1', ADMIN)).thresholds;
  };

  it('el piso del hueco deja lugar al muestreo de AHORRO de bateria', async () => {
    // Con el intervalo normal (60 s) el piso seria 120 s, pero la app espacia a
    // 300 s cuando la bateria baja: con 300 s de umbral, CADA muestra del modo
    // ahorro se declaraba hueco y la ronda entera aparecia sin cobertura.
    const umbrales = await conReglas({});

    expect(umbrales.gapMinSeconds).toBe(600);
    expect(umbrales.stopMinSeconds).toBe(600);
  });

  it('el piso sigue al intervalo cuando el admin lo sube', async () => {
    const umbrales = await conReglas({ gpsTrackIntervalSeconds: 900 });

    expect(umbrales.gapMinSeconds).toBe(1800);
    expect(umbrales.stopMinSeconds).toBe(1800);
  });

  it('el override que escribe el admin llega hasta el umbral aplicado', async () => {
    // Este caso pasa los tres parametros por patrolRulesSchema A PROPOSITO: si
    // rules.ts todavia no los declara, el parse DESCARTA las claves y este test
    // se cae. Es la alarma de que falta aplicar la seccion 3 de INTEGRACION.md,
    // en vez de un panel que guarda un numero que el servidor nunca aplica.
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);
    const { service } = servicio(query, {
      overrides: patrolRulesSchema.parse({
        gpsTrackGapMinSeconds: 1200,
        gpsTrackStopMinSeconds: 1500,
        gpsTrackStopRadiusM: 40,
      }),
    });

    const umbrales = (await service.patrolTrackSummary('patrol-1', ADMIN)).thresholds;

    expect(umbrales.gapMinSeconds).toBe(1200);
    expect(umbrales.stopMinSeconds).toBe(1500);
    expect(umbrales.stopRadiusM).toBe(40);
  });

  it('la precision de MEDIR no la mueve la regla de dibujo del mapa', async () => {
    // mapTrackMaxAccuracyM es "Precision minima del trazo" del informe (#79). Un
    // admin que la baja para limpiar el PDF no puede cambiar la distancia que
    // devuelve la API, porque GeoService.patrolTrack no la lee.
    const umbrales = await conReglas({ mapTrackMaxAccuracyM: 30 });

    expect(umbrales.maxAccuracyM).toBe(100);
  });
});

describe('TrazaMetricasService — serie diaria del recinto (#134)', () => {
  const RECINTO = [{ id: 'site-1', name: 'Planta Norte', timezone: 'America/Santiago' }];
  const DIAS = [
    { service_day: '2026-08-01', desde: '2026-08-01', hasta: '2026-08-02' },
    { service_day: '2026-08-02', desde: '2026-08-01', hasta: '2026-08-02' },
  ];

  it('agrupa por dia del recinto y deja los dias sin rondas en cero', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(RECINTO)
      .mockResolvedValueOnce(DIAS)
      .mockResolvedValueOnce([
        {
          id: 'patrol-1',
          service_day: '2026-08-02',
          started_at: en(0),
          closed_at: en(3),
        },
      ])
      .mockResolvedValueOnce([
        punto(0, 0, 'patrol-1'),
        punto(1, 1, 'patrol-1'),
        punto(2, 2, 'patrol-1'),
      ]);

    const { service } = servicio(query);
    const salida = await service.siteTrackDaily('site-1', 2, ADMIN);

    expect(salida.timezone).toBe('America/Santiago');
    expect(salida.series).toHaveLength(2);
    expect(salida.series[0]).toMatchObject({
      serviceDay: '2026-08-01',
      analyzedPatrols: 0,
      distanceM: 0,
    });
    expect(salida.series[1]?.analyzedPatrols).toBe(1);
    expect(salida.series[1]?.analyzedWithTrack).toBe(1);
    expect(salida.series[1]?.distanceM).toBeGreaterThan(150);
    expect(salida.totals.distanceM).toBe(salida.series[1]?.distanceM);
    expect(salida.truncated).toBe(false);
  });

  it('resuelve el dia con la zona del recinto y suma los dias sin zona', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(RECINTO)
      .mockResolvedValueOnce(DIAS)
      .mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await service.siteTrackDaily('site-1', 2, ADMIN);

    const consultaDias = sqlDe(query)[1] ?? '';
    const consultaRondas = sqlDe(query)[2] ?? '';
    // El dia viaja como TEXTO: una columna date la convierte el driver a
    // medianoche local del servidor y se pierde el dia del recinto.
    expect(consultaDias).toContain(`to_char(g.dia, 'YYYY-MM-DD')`);
    expect(consultaDias).toContain('now() AT TIME ZONE $1::text');
    expect(consultaRondas).toContain('app_stats_service_day');
    expect(consultaRondas).toContain(`to_char(q.dia, 'YYYY-MM-DD')`);
    // La suma de dias se aplica al timestamp SIN zona ANTES de convertir.
    expect(consultaRondas).toContain(`($3::date::timestamp - INTERVAL '1 day') AT TIME ZONE`);
    expect(consultaRondas).toContain(`($4::date::timestamp + INTERVAL '2 days') AT TIME ZONE`);
  });

  it('acota el dia de servicio ANTES del tope, no despues', async () => {
    // La banda del WHERE llega hasta manana y el orden es descendente: si el
    // LIMIT se aplicara antes del corte por dia, las rondas futuras se comerian
    // las primeras ranuras del tope y los dias mas viejos quedarian en cero.
    const query = jest
      .fn()
      .mockResolvedValueOnce(RECINTO)
      .mockResolvedValueOnce(DIAS)
      .mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await service.siteTrackDaily('site-1', 2, ADMIN);

    const consultaRondas = sqlDe(query)[2] ?? '';
    const corte = consultaRondas.indexOf('q.dia >= $3::date');
    const tope = consultaRondas.indexOf('LIMIT $5::int');
    expect(corte).toBeGreaterThan(-1);
    expect(tope).toBeGreaterThan(corte);
    // Los parentesis del SQL, contados: uno de mas o de menos no lo ve ningun
    // mock, solo Postgres.
    expect((consultaRondas.match(/\(/g) ?? []).length).toBe(
      (consultaRondas.match(/\)/g) ?? []).length,
    );
  });

  it('la ronda SIN ninguna posicion tambien suma su hueco', async () => {
    // Es el caso maximo de "no sabemos donde estaba". Saltearla hacia que un dia
    // de rondas mudas se viera MEJOR que uno con un punto por ronda.
    const query = jest
      .fn()
      .mockResolvedValueOnce(RECINTO)
      .mockResolvedValueOnce(DIAS)
      .mockResolvedValueOnce([
        { id: 'patrol-1', service_day: '2026-08-02', started_at: en(0), closed_at: en(60) },
      ])
      .mockResolvedValueOnce([]);

    const { service } = servicio(query);
    const salida = await service.siteTrackDaily('site-1', 2, ADMIN);

    expect(salida.analyzedPatrols).toBe(1);
    expect(salida.analyzedWithTrack).toBe(0);
    expect(salida.series[1]?.gapCount).toBe(1);
    expect(salida.series[1]?.gapMinutes).toBe(60);
    expect(salida.totals.gapMinutes).toBe(60);
    expect(salida.totals.movingMinutes).toBe(0);
  });

  it('descarta las rondas de la banda que caen fuera del periodo pedido', async () => {
    // El corte fino ya lo hace el SQL; esta es la red de seguridad en memoria,
    // por eso el mock devuelve una fila que la consulta real no traeria.
    const query = jest
      .fn()
      .mockResolvedValueOnce(RECINTO)
      .mockResolvedValueOnce(DIAS)
      .mockResolvedValueOnce([
        {
          id: 'patrol-9',
          service_day: '2026-07-31',
          started_at: en(0),
          closed_at: en(3),
        },
      ]);

    const { service } = servicio(query);
    const salida = await service.siteTrackDaily('site-1', 2, ADMIN);

    expect(salida.analyzedPatrols).toBe(0);
    // Sin rondas del periodo no se piden puntos: la cuarta consulta no existe.
    expect(query).toHaveBeenCalledTimes(3);
    expect(salida.series.every((dia) => dia.analyzedPatrols === 0)).toBe(true);
  });

  it('el SUPERVISOR sin el recinto asignado no ve la serie', async () => {
    const ensure = jest.fn().mockRejectedValue(new ForbiddenException('No tienes este recinto asignado'));
    const query = jest.fn();

    const { service } = servicio(query, { ensure });
    await expect(service.siteTrackDaily('site-1', 7, SUPERVISOR)).rejects.toThrow(
      'No tienes este recinto asignado',
    );
    // Se verifica ANTES de leer nada del recinto.
    expect(query).not.toHaveBeenCalled();
  });

  it('un recinto inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    const { service } = servicio(query);
    await expect(service.siteTrackDaily('site-1', 7, ADMIN)).rejects.toThrow(
      'El recinto no existe',
    );
  });
});
