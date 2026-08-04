import { patrolRulesSchema } from '@voxia/shared';

import type { AuditService } from '../audit/audit.service';
import type { AlertsService } from '../alerts/alerts.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { SchedulingService } from './scheduling.service';

/**
 * Turno nocturno del lunes 2026-08-03 en Santiago: 22:00 -> 06:00. En agosto
 * Chile esta en UTC-4, asi que la ventana real va de 02:00Z del martes a 10:00Z
 * del martes. Esos instantes los calcula PostgreSQL con AT TIME ZONE; aca se
 * mockean tal como los devuelve el driver para probar lo que hace el servicio
 * CON ellos.
 */
const NOCHE_INICIO = new Date('2026-08-04T02:00:00.000Z');
const NOCHE_FIN = new Date('2026-08-04T10:00:00.000Z');

const sinReglas = () =>
  ({
    effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})),
  }) as unknown as RulesService;

function servicio(query: jest.Mock) {
  const sortearOrden = jest.fn((puntos: Array<{ checkpoint_id: string }>) =>
    puntos.map((p) => p.checkpoint_id),
  );
  const supervisor = {
    ensureAssignedSite: jest.fn().mockResolvedValue(undefined),
    sortearOrden,
  } as unknown as SupervisorService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const alerts = {
    schedulePatrol: jest.fn().mockResolvedValue(undefined),
  } as unknown as AlertsService;

  const service = new SchedulingService(
    { manager: { query } } as unknown as TenantContextService,
    supervisor,
    sinReglas(),
    audit,
    alerts,
  );
  return { service, supervisor, audit, sortearOrden };
}

interface FilaOverrides {
  [clave: string]: unknown;
}

/** Una fila del plan: un hueco de ronda dentro de un turno. */
function slot(over: FilaOverrides = {}) {
  return {
    assignment_id: 'asig-noche',
    guard_id: 'guard-1',
    guard_name: 'Ana Diaz',
    shift_id: 'turno-noche',
    shift_name: 'Nocturno',
    site_id: 'site-1',
    site_name: 'Planta Sur',
    timezone: 'America/Santiago',
    route_id: 'ruta-noche',
    route_name: 'Perimetro',
    order_mode: 'fijo',
    requested_count: 2,
    planned_count: 2,
    seq: 1,
    window_start: NOCHE_INICIO,
    window_end: new Date('2026-08-04T06:00:00.000Z'),
    window_elapsed: false,
    already_exists: false,
    skip_reason: null,
    ...over,
  };
}

const SEGUNDA_RONDA = {
  seq: 2,
  window_start: new Date('2026-08-04T06:00:00.000Z'),
  window_end: NOCHE_FIN,
};

const PUNTOS_NOCHE = [
  { route_id: 'ruta-noche', checkpoint_id: 'cp-1', is_closing_point: false, is_anchor: false },
  { route_id: 'ruta-noche', checkpoint_id: 'cp-2', is_closing_point: true, is_anchor: false },
];

const inserts = (query: jest.Mock) =>
  query.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO patrols'));

describe('SchedulingService — generacion por patron (#62, #132)', () => {
  it('genera una ronda por hueco del turno y la cuelga de su asignacion', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot(), slot(SEGUNDA_RONDA)])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([{ id: 'patrol-1' }])
      .mockResolvedValueOnce([{ id: 'patrol-2' }])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({ generated: 2, skipped: 0, runId: 'run-1' });

    const [primera, segunda] = inserts(query);
    expect(primera[1][7]).toBe('asig-noche');
    expect(primera[1][8]).toBe(1);
    expect(segunda[1][8]).toBe(2);
    expect(primera[0]).toContain('schedule_seq');
  });

  it('cada turno lleva SU ruta y SU frecuencia: el de noche no hereda al de dia', async () => {
    const dia = slot({
      assignment_id: 'asig-dia',
      shift_id: 'turno-dia',
      shift_name: 'Diurno',
      route_id: 'ruta-dia',
      requested_count: 1,
      planned_count: 1,
      seq: 1,
      window_start: new Date('2026-08-03T12:00:00.000Z'),
      window_end: new Date('2026-08-03T20:00:00.000Z'),
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot(), slot(SEGUNDA_RONDA), dia])
      .mockResolvedValueOnce([
        ...PUNTOS_NOCHE,
        { route_id: 'ruta-dia', checkpoint_id: 'cp-9', is_closing_point: false, is_anchor: false },
        { route_id: 'ruta-dia', checkpoint_id: 'cp-8', is_closing_point: true, is_anchor: false },
      ])
      .mockResolvedValueOnce([{ id: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'p-2' }])
      .mockResolvedValueOnce([{ id: 'p-3' }])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service, sortearOrden } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({ generated: 3 });

    const rutas = inserts(query).map(([, params]: [string, unknown[]]) => params[2]);
    expect(rutas).toEqual(['ruta-noche', 'ruta-noche', 'ruta-dia']);

    const puntosDiurnos = inserts(query)[2]![1][6];
    expect(JSON.parse(puntosDiurnos)).toEqual(['cp-9', 'cp-8']);

    // El sorteo se rehace en CADA ronda: cuatro rondas de la misma noche con el
    // mismo orden serian tan predecibles como una sola.
    expect(sortearOrden).toHaveBeenCalledTimes(3);
  });

  it('sin patron el turno no genera nada, y se dice por que', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        slot({
          route_id: null,
          route_name: null,
          order_mode: null,
          requested_count: null,
          planned_count: null,
          seq: null,
          window_start: null,
          window_end: null,
          skip_reason: 'el turno no tiene patron de rondas activo',
        }),
      ])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({
      generated: 0,
      skipped: 1,
      skippedByReason: { 'el turno no tiene patron de rondas activo': 1 },
    });
    expect(inserts(query)).toHaveLength(0);
  });

  it('el guardia ausente no recibe rondas generadas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        slot({ skip_reason: 'el guardia esta marcado ausente', seq: null, planned_count: null }),
      ])
      .mockResolvedValueOnce([]) // secuencia de la ruta del patron
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({ generated: 0, skipped: 1 });
    expect(inserts(query)).toHaveLength(0);
  });
});

describe('SchedulingService — idempotencia (#62)', () => {
  it('la segunda corrida del mismo dia no vuelve a insertar', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        slot({ already_exists: true }),
        slot({ ...SEGUNDA_RONDA, already_exists: true }),
      ])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([{ id: 'run-2', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({
      generated: 0,
      skipped: 2,
      skippedByReason: { 'la ronda ya estaba generada': 2 },
    });
    expect(inserts(query)).toHaveLength(0);
  });

  it('dos corridas simultaneas no duplican: el INSERT que pierde no cuenta', async () => {
    // La otra corrida inserto entre el plan y el INSERT: el indice unico gana y
    // ON CONFLICT DO NOTHING devuelve cero filas.
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot()])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([]) // ON CONFLICT DO NOTHING
      .mockResolvedValueOnce([{ id: 'run-3', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({ generated: 0, skipped: 1 });
    expect(inserts(query)[0]![0]).toContain('ON CONFLICT');
    expect(inserts(query)[0]![0]).toContain('DO NOTHING');
  });

  it('cada corrida queda registrada en schedule_runs, generen o no', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot({ already_exists: true })])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([{ id: 'run-4', ran_at: new Date() }]);
    const { service } = servicio(query);

    await service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' });

    const corrida = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO schedule_runs'),
    );
    expect(corrida[1]).toEqual([null, '2026-08-03', 0, 1, null]);
  });
});

describe('SchedulingService — zona horaria del recinto (#62)', () => {
  it('el turno nocturno queda en el dia de servicio correcto aunque cruce medianoche', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot(), slot(SEGUNDA_RONDA)])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([{ id: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'p-2' }])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' });

    const [primera, segunda] = inserts(query);
    // La segunda ronda ocurre ya en la madrugada del martes...
    expect(segunda[1][4]).toEqual(new Date('2026-08-04T06:00:00.000Z'));
    expect(segunda[1][5]).toEqual(NOCHE_FIN);
    // ...y sigue perteneciendo a la jornada del lunes.
    expect(segunda[1][7]).toBe('asig-noche');
    expect(primera[1][4]).toEqual(NOCHE_INICIO);

    const corrida = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO schedule_runs'),
    );
    expect(corrida[1][1]).toBe('2026-08-03');
  });

  it('la ventana se calcula en SQL con la zona del recinto, no con offsets fijos', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' });

    const plan: string = query.mock.calls[0]![0];
    expect(plan).toContain('AT TIME ZONE si.timezone');
    // El dia siguiente se suma ANTES de convertir a instante: asi el turno se
    // ancla al reloj de la pared y el cambio de hora no lo desplaza.
    expect(plan).toContain(`INTERVAL '1 day'`);
    // Un offset escrito a mano es la regresion que este test bloquea.
    expect(plan).not.toMatch(/[-+]0[34]:00/);
  });

  it('no genera rondas cuya ventana ya vencio', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([slot({ window_elapsed: true })])
      .mockResolvedValueOnce(PUNTOS_NOCHE)
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service } = servicio(query);

    await expect(
      service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' }),
    ).resolves.toMatchObject({
      generated: 0,
      skippedByReason: { 'la ventana de la ronda ya vencio': 1 },
    });
    expect(inserts(query)).toHaveLength(0);
  });
});

describe('SchedulingService — alcance del supervisor', () => {
  it('previewDay no escribe nada y exige el recinto asignado', async () => {
    const query = jest.fn().mockResolvedValueOnce([slot(), slot(SEGUNDA_RONDA)]);
    const { service, supervisor } = servicio(query);

    await expect(service.previewDay('site-1', '2026-08-03', 'sup-1')).resolves.toMatchObject({
      timezone: 'America/Santiago',
      totals: { toGenerate: 2, alreadyExisting: 0, elapsed: 0, skipped: 0 },
    });
    expect(supervisor.ensureAssignedSite).toHaveBeenCalledWith('site-1', 'sup-1');
    const escrituras = query.mock.calls.filter(([sql]: [string]) =>
      /INSERT|UPDATE|DELETE/.test(sql),
    );
    expect(escrituras).toHaveLength(0);
  });

  it('generar sin recinto acota el plan a los recintos asignados del supervisor', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }])
      .mockResolvedValueOnce([{ label: 'Sara Supervisora' }]);
    const { service, audit } = servicio(query);

    await service.generateForDate(
      { serviceDate: '2026-08-03' },
      { kind: 'supervisor', supervisorId: 'sup-1' },
    );

    expect(query.mock.calls[0]![1]).toEqual(['2026-08-03', null, 'sup-1']);
    expect(query.mock.calls[0]![0]).toContain('supervisor_sites');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rondas.generadas', actorLabel: 'Sara Supervisora' }),
    );
  });

  it('la corrida del job no lleva supervisor y no filtra por recintos asignados', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'run-1', ran_at: new Date() }]);
    const { service, audit } = servicio(query);

    await service.generateForDate({ serviceDate: '2026-08-03' }, { kind: 'sistema' });

    expect(query.mock.calls[0]![1]).toEqual(['2026-08-03', null, null]);
    // Sin persona detras no se inventa un actor: la trazabilidad la da schedule_runs.
    expect(audit.record).not.toHaveBeenCalled();
  });
});
