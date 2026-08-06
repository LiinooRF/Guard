import { patrolRulesSchema } from '@voxia/shared';

import { GpsPolicyService } from './gps-policy.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';

/**
 * Los siete parametros de #77 ya viven en `patrolRulesSchema`, asi que salen del
 * parse con su default del catalogo y no se inyectan a mano. Los tests que los
 * necesitan distintos los pasan explicitos, igual que cualquier otra regla.
 */
const reglas = (overrides: Record<string, unknown> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({
      ...patrolRulesSchema.parse({}),
      ...overrides,
    }),
  }) as unknown as RulesService;

const supervisorOk = () =>
  ({ ensureAssignedSite: jest.fn().mockResolvedValue(undefined) }) as unknown as SupervisorService;

function servicio(
  query: jest.Mock,
  overrides: Record<string, unknown> = {},
  supervisor: SupervisorService = supervisorOk(),
) {
  return new GpsPolicyService(
    { manager: { query } } as unknown as TenantContextService,
    reglas(overrides),
    supervisor,
  );
}

const sqlDe = (query: jest.Mock): string[] =>
  query.mock.calls.map(([sql]: [string]) => sql);

const RONDA = { id: 'patrol-1', site_id: 'site-1', status: 'pendiente' };
const CONSENTIMIENTO = [{ granted_at: new Date('2026-08-01T08:00:00Z'), policy_version: 'v1' }];
const permiso = (status: string, minutosAtras = 5) => [
  { status, reported_at: new Date(Date.now() - minutosAtras * 60_000) },
];

/** Secuencia de evaluarInicio(): ronda, consentimiento, permiso, INSERT del gate. */
const inicioCon = (consentimiento: unknown[], permisos: unknown[]) =>
  jest.fn()
    .mockResolvedValueOnce([RONDA])
    .mockResolvedValueOnce(consentimiento)
    .mockResolvedValueOnce(permisos)
    .mockResolvedValueOnce([]); // INSERT ... ON CONFLICT sin RETURNING

describe('GpsPolicyService — GPS obligatorio (#77)', () => {
  it('con GPS obligatorio y permiso denegado, la ronda NO arranca', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('denegado'));

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).rejects.toThrow('Activa el permiso de ubicación');
  });

  it('con GPS obligatorio y sin consentimiento, pide aceptar el aviso primero', async () => {
    const query = inicioCon([], permiso('concedido'));

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).rejects.toThrow('aceptar el aviso de compartir ubicación');
  });

  it('con GPS obligatorio, consentimiento y permiso vigente, arranca y se registra', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('concedido'));

    const decision = await servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
      'guard-1',
      'patrol-1',
    );

    expect(decision).toMatchObject({
      mode: 'obligatorio',
      canStartPatrol: true,
      blockedReason: null,
      tracksLocation: true,
    });
  });

  /** Criterio de aceptacion: "con GPS opcional, negar el permiso no impide trabajar". */
  it('con GPS opcional, negar el permiso NO impide iniciar la ronda', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('denegado'));

    const decision = await servicio(query, { gpsSharingMandatory: false }).assertPatrolStartAllowed(
      'guard-1',
      'patrol-1',
    );

    expect(decision).toMatchObject({
      mode: 'opcional',
      canStartPatrol: true,
      blockedReason: null,
      tracksLocation: false,
    });
    expect(decision.message).toContain('opcional');
  });

  it('sin reporte del teléfono y GPS obligatorio, no arranca: falla cerrada', async () => {
    const query = inicioCon(CONSENTIMIENTO, []);

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).rejects.toThrow('todavía no confirmó el permiso');
  });

  it('un reporte de permiso vencido vale lo mismo que ninguno', async () => {
    // 13 horas atras, con la ventana por defecto de 720 minutos.
    const query = inicioCon(CONSENTIMIENTO, permiso('concedido', 13 * 60));

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).rejects.toThrow('todavía no confirmó el permiso');
  });

  it('solo_primer_plano alcanza para trabajar: el permiso de fondo es otro trámite', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('solo_primer_plano'));

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).resolves.toMatchObject({ canStartPatrol: true, tracksLocation: true });
  });

  it('con el seguimiento apagado, el modo obligatorio no bloquea a nadie', async () => {
    const query = inicioCon([], []);

    await expect(
      servicio(query, {
        gpsSharingMandatory: true,
        gpsTrackingEnabled: false,
      }).assertPatrolStartAllowed('guard-1', 'patrol-1'),
    ).resolves.toMatchObject({ canStartPatrol: true, tracksLocation: false });
  });

  /**
   * LA TRAMPA DE ESTE ISSUE, escrita como test para que no vuelva a leerse mal.
   *
   * `gpsSharingMandatory` es obligatorio vs OPCIONAL. `gpsTrackingEnabled` es
   * encendido vs apagado. Con GPS OPCIONAL y seguimiento ENCENDIDO, al guardia
   * que acepto y comparte se le registra el recorrido igual que en modo
   * obligatorio: lo unico que cambia es que negar el permiso no le impide
   * trabajar. Leerlo como un interruptor dejaba sin traza a toda empresa que
   * eligiera no obligar.
   */
  it('opcional NO es apagado: con GPS opcional el que aceptó igual queda registrado', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('concedido'));

    const decision = await servicio(query, {
      gpsSharingMandatory: false,
      gpsTrackingEnabled: true,
    }).assertPatrolStartAllowed('guard-1', 'patrol-1');

    expect(decision).toMatchObject({
      mode: 'opcional',
      trackingEnabled: true,
      tracksLocation: true,
      canStartPatrol: true,
      blockedReason: null,
    });
  });

  /** Y al reves: obligatorio con el seguimiento apagado no registra a nadie. */
  it('el modo obligatorio con el seguimiento apagado no registra recorrido', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('concedido'));

    const decision = await servicio(query, {
      gpsSharingMandatory: true,
      gpsTrackingEnabled: false,
    }).assertPatrolStartAllowed('guard-1', 'patrol-1');

    expect(decision).toMatchObject({
      mode: 'obligatorio',
      trackingEnabled: false,
      tracksLocation: false,
      canStartPatrol: true,
    });
  });

  /**
   * La vigencia del reporte de permiso es configurable (#77). Con el parametro
   * fuera del schema, la empresa que la bajaba a 4 horas seguia corriendo con
   * las 12 del default y no habia forma de notarlo.
   */
  it('la vigencia del reporte de permiso sale de la regla configurada', async () => {
    // Reportado hace 6 horas: vigente con el default de 720 min...
    const vigente = inicioCon(CONSENTIMIENTO, permiso('concedido', 6 * 60));
    await expect(
      servicio(vigente, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).resolves.toMatchObject({ canStartPatrol: true });

    // ...y vencido si la empresa exige confirmarlo cada 4 horas.
    const estricto = inicioCon(CONSENTIMIENTO, permiso('concedido', 6 * 60));
    await expect(
      servicio(estricto, {
        gpsSharingMandatory: true,
        gpsPermissionReportMaxAgeMin: 240,
      }).assertPatrolStartAllowed('guard-1', 'patrol-1'),
    ).rejects.toThrow('todavía no confirmó el permiso');
  });

  it('la ronda de otro guardia no existe para este', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await expect(
      servicio(query).assertPatrolStartAllowed('guard-1', 'patrol-9'),
    ).rejects.toThrow('La ronda asignada no existe');
  });

  it('deja escrita la decisión, con el modo que regía y el motivo del bloqueo', async () => {
    const query = inicioCon(CONSENTIMIENTO, permiso('denegado'));

    await expect(
      servicio(query, { gpsSharingMandatory: true }).assertPatrolStartAllowed(
        'guard-1',
        'patrol-1',
      ),
    ).rejects.toThrow();

    const registro = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO patrol_gps_gate'),
    );
    expect(registro).toBeDefined();
    // [patrolId, mode, permission_status, consent_granted, allowed, blocked_reason]
    expect(registro[1]).toEqual([
      'patrol-1',
      'obligatorio',
      'denegado',
      true,
      false,
      'permiso_denegado',
    ]);
  });

  it('el chequeo previo responde el estado en vez de reventar', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ status: 'denegado', reported_at: new Date() }]) // reporte
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce(CONSENTIMIENTO)
      .mockResolvedValueOnce(permiso('denegado'))
      .mockResolvedValueOnce([]);

    await expect(
      servicio(query, { gpsSharingMandatory: true }).patrolStartCheck('guard-1', 'patrol-1', {
        status: 'denegado',
        deviceInfo: 'Moto G54',
      }),
    ).resolves.toMatchObject({
      canStartPatrol: false,
      blockedReason: 'permiso_denegado',
      patrolStatus: 'pendiente',
    });
  });
});

describe('GpsPolicyService — plan de muestreo', () => {
  it('entrega el intervalo del tenant y el plan de ahorro de batería', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(CONSENTIMIENTO)
      .mockResolvedValueOnce(permiso('concedido'));

    const politica = await servicio(query, { gpsTrackIntervalSeconds: 120 }).policy('guard-1');

    expect(politica.sampling).toMatchObject({
      intervalSeconds: 120,
      minDistanceM: 15,
      maxAccuracyM: 100,
      batchSize: 60,
      lowBatteryPct: 15,
      lowBatteryIntervalSeconds: 300,
    });
  });

  it('el modo ahorro nunca muestrea más seguido que el modo normal', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(CONSENTIMIENTO)
      .mockResolvedValueOnce(permiso('concedido'));

    const politica = await servicio(query, {
      gpsTrackIntervalSeconds: 600,
      gpsTrackLowBatteryIntervalSeconds: 60,
    }).policy('guard-1');

    expect(politica.sampling.lowBatteryIntervalSeconds).toBe(600);
  });

  it('el lote nunca supera lo que acepta el endpoint de traza', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(CONSENTIMIENTO)
      .mockResolvedValueOnce(permiso('concedido'));

    const politica = await servicio(query, { gpsTrackBatchSize: 5000 }).policy('guard-1');

    expect(politica.sampling.batchSize).toBe(500);
  });
});

describe('GpsPolicyService — consumo de batería', () => {
  const RONDA_CERRADA = {
    id: 'patrol-1',
    site_id: 'site-1',
    guard_id: 'guard-1',
    status: 'completada',
    started_at: new Date('2026-08-01T10:00:00Z'),
    closed_at: new Date('2026-08-01T18:00:00Z'),
  };

  const agregado = (overrides: Record<string, unknown> = {}) => [
    {
      total_points: 460,
      battery_points: 460,
      first_at: new Date('2026-08-01T10:00:00Z'),
      last_at: new Date('2026-08-01T18:00:00Z'),
      battery_first_at: new Date('2026-08-01T10:00:00Z'),
      battery_last_at: new Date('2026-08-01T18:00:00Z'),
      min_pct: 88,
      max_pct: 100,
      first_pct: 100,
      last_pct: 88,
      ...overrides,
    },
  ];

  it('proyecta el consumo a la ronda completa y lo compara con el presupuesto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([RONDA_CERRADA])
      .mockResolvedValueOnce(agregado());

    const informe = await servicio(query).patrolBattery('patrol-1', {
      sub: 'admin-1',
      role: 'ADMIN',
    });

    // 12 puntos en 8 horas = 1.5 %/h; la ronda de referencia
    // (maxPatrolDurationMin = 480) son 8 horas: 12% proyectado contra 20% de
    // presupuesto.
    expect(informe).toMatchObject({
      drainPct: 12,
      drainPctPerHour: 1.5,
      referenceHours: 8,
      projectedDrainPct: 12,
      budgetPct: 20,
      withinBudget: true,
      measurable: true,
    });
    expect(informe.expectedSamples).toBe(481);
  });

  /**
   * El presupuesto de bateria es una promesa comercial y cada empresa tiene la
   * suya. Mientras el parametro vivio fuera del schema, el override se descartaba
   * en el parse y el informe comparaba contra 20% para todo el mundo.
   */
  it('el presupuesto de batería con el que se compara es el configurado', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([RONDA_CERRADA])
      .mockResolvedValueOnce(agregado());

    // Los mismos 12% proyectados, ahora contra un presupuesto de 10%.
    const informe = await servicio(query, { gpsBatteryBudgetPct: 10 }).patrolBattery('patrol-1', {
      sub: 'admin-1',
      role: 'ADMIN',
    });

    expect(informe).toMatchObject({
      projectedDrainPct: 12,
      budgetPct: 10,
      withinBudget: false,
    });
  });

  it('si el teléfono se cargó a mitad de ronda, no se proyecta nada', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([RONDA_CERRADA])
      .mockResolvedValueOnce(agregado({ first_pct: 40, max_pct: 95, last_pct: 90, min_pct: 35 }));

    const informe = await servicio(query).patrolBattery('patrol-1', {
      sub: 'admin-1',
      role: 'ADMIN',
    });

    expect(informe).toMatchObject({
      rechargedDuringPatrol: true,
      measurable: false,
      projectedDrainPct: null,
      withinBudget: null,
    });
  });

  it('una ronda sin puntos responde el informe vacío, no un error', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([RONDA_CERRADA])
      // La agregacion sin GROUP BY devuelve una fila con ceros y NULL.
      .mockResolvedValueOnce([
        {
          total_points: 0,
          battery_points: 0,
          first_at: null,
          last_at: null,
          battery_first_at: null,
          battery_last_at: null,
          min_pct: null,
          max_pct: null,
          first_pct: null,
          last_pct: null,
        },
      ]);

    await expect(
      servicio(query).patrolBattery('patrol-1', { sub: 'admin-1', role: 'ADMIN' }),
    ).resolves.toMatchObject({ samples: 0, measurable: false, drainPct: null });
  });

  it('el supervisor solo ve rondas de sus recintos asignados', async () => {
    const supervisor = {
      ensureAssignedSite: jest.fn().mockRejectedValue(new Error('No tienes este recinto asignado')),
    } as unknown as SupervisorService;
    const query = jest.fn().mockResolvedValueOnce([RONDA_CERRADA]);

    await expect(
      servicio(query, {}, supervisor).patrolBattery('patrol-1', {
        sub: 'supervisor-9',
        role: 'SUPERVISOR',
      }),
    ).rejects.toThrow('No tienes este recinto asignado');
    expect(supervisor.ensureAssignedSite).toHaveBeenCalledWith('site-1', 'supervisor-9');
  });
});

describe('GpsPolicyService — cobertura de recorrido por día', () => {
  it('agrupa por el día del RECINTO y no por el del servidor', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'site-1', name: 'Bodega Norte', timezone: 'America/Santiago' },
      ])
      .mockResolvedValueOnce([
        { service_day: '2026-07-31', rondas: 4, con_traza: 4 },
        { service_day: '2026-08-01', rondas: 4, con_traza: 3 },
      ]);

    const informe = await servicio(query).siteGpsCoverage('site-1', 2, {
      sub: 'admin-1',
      role: 'ADMIN',
    });

    expect(informe).toMatchObject({
      timezone: 'America/Santiago',
      patrols: 8,
      withTrack: 7,
      coveragePct: 87.5,
    });
    expect(informe.series[1]).toMatchObject({
      serviceDay: '2026-08-01',
      withoutTrack: 1,
      coveragePct: 75,
    });

    const sql = sqlDe(query)[1]!;
    // El dia del turno manda; si no hay turno, el dia calendario DEL RECINTO.
    expect(sql).toContain('app_stats_service_day');
    // La suma de dias se aplica al timestamp SIN zona ANTES de convertir: al
    // reves serian 24 horas fijas y el cambio de horario correria el corte.
    expect(sql).toContain("(rango.hasta::timestamp + INTERVAL '2 days') AT TIME ZONE rango.tz");
    expect(query.mock.calls[1][1]).toEqual(['site-1', 'America/Santiago', 2]);
  });

  it('un recinto que no existe en este tenant no devuelve una serie vacía', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await expect(
      servicio(query).siteGpsCoverage('site-9', 7, { sub: 'admin-1', role: 'ADMIN' }),
    ).rejects.toThrow('El recinto no existe');
  });
});
