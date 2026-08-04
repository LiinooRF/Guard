import { DEFAULT_PATROL_RULES, type PatrolRules } from '@voxia/shared';

import { SupervisorService } from './supervisor.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

const SUPERVISOR = 'supervisor-id';

function servicio(query: jest.Mock, reglas: Partial<PatrolRules> = {}) {
  const rules = {
    effective: jest.fn().mockResolvedValue({ ...DEFAULT_PATROL_RULES, ...reglas }),
  } as unknown as RulesService;
  return new SupervisorService({ manager: { query } } as unknown as TenantContextService, rules);
}

/** Math.random determinista: devuelve la secuencia dada, ciclando. */
function conAzar(valores: number[]) {
  let i = 0;
  return jest.spyOn(Math, 'random').mockImplementation(() => valores[i++ % valores.length]!);
}

/** Mocks en cadena para un createPatrol completo. */
function mocksRonda(
  orderMode: string | undefined,
  puntos: Array<{ checkpoint_id: string; is_closing_point: boolean; is_anchor: boolean }>,
) {
  return jest.fn()
    .mockResolvedValueOnce([{ site_id: 'site-id', version: 1, order_mode: orderMode }])
    .mockResolvedValueOnce([{ present: true }]) // recinto asignado
    .mockResolvedValueOnce([{ user_id: 'guard-id' }]) // membresia GUARDIA
    .mockResolvedValueOnce(puntos) // secuencia actual
    .mockResolvedValueOnce([]); // INSERT patrol
}

function snapshotInsertado(query: jest.Mock): string[] {
  const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO patrols'));
  return JSON.parse(insert[1][6]);
}

const DTO_RONDA = {
  guardId: 'guard-id',
  scheduledStartAt: '2026-08-04T22:00:00-04:00',
  scheduledEndAt: '2026-08-05T06:00:00-04:00',
};

const punto = (id: string, extra: Partial<{ is_closing_point: boolean; is_anchor: boolean }> = {}) => ({
  checkpoint_id: id,
  is_closing_point: false,
  is_anchor: false,
  ...extra,
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SupervisorService', () => {
  it('el catálogo del editor contiene solo recintos asignados y normaliza coordenadas', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      id: 'site-id', name: 'Planta Sur', branch_name: 'Santiago', address: 'Uno 123',
      latitude: '-33.450000', longitude: '-70.660000', checkpoints: [{
        id: 'cp-1', name: 'Acceso', latitude: '-33.451000', longitude: '-70.661000',
        requiresPhoto: true, suggestedOrder: 1,
      }],
    }]);

    await expect(servicio(query).routeEditorSites(SUPERVISOR)).resolves.toEqual([{
      id: 'site-id', name: 'Planta Sur', branchName: 'Santiago', address: 'Uno 123',
      latitude: -33.45, longitude: -70.66, checkpoints: [expect.objectContaining({
        id: 'cp-1', latitude: -33.451, longitude: -70.661,
      })],
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      'WHERE scope.supervisor_id = $1'), [SUPERVISOR]);
  });

  it('un recinto NO asignado responde 403, aunque el permiso alcance', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // supervisor_sites vacio
    await expect(servicio(query).listRoutes('site-id', SUPERVISOR)).rejects.toThrow(
      'No tienes este recinto asignado',
    );
  });

  it('sin punto de cierre marcado, el ultimo de la secuencia cierra la ronda', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ present: true }]) // recinto asignado
      .mockResolvedValueOnce([]) // INSERT routes
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-3' }]);
    await servicio(query).createRoute('site-id', SUPERVISOR, {
      name: 'Nocturna',
      estimatedDurationMin: 30,
      checkpoints: [
        { checkpointId: 'cp-1' },
        { checkpointId: 'cp-2' },
        { checkpointId: 'cp-3' },
      ],
    });
    // los insert de la secuencia: el tercero (y solo el) va con is_closing_point=true
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('route_checkpoints'));
    expect(inserts.map((c) => c[1][3])).toEqual([false, false, true]);
  });

  it('createRoute persiste order_mode e is_anchor', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]) // INSERT routes
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }]);
    await servicio(query).createRoute('site-id', SUPERVISOR, {
      name: 'Nocturna',
      estimatedDurationMin: 30,
      orderMode: 'aleatorio_con_anclas',
      checkpoints: [
        { checkpointId: 'cp-1', isAnchor: true },
        { checkpointId: 'cp-2' },
      ],
    });
    const ruta = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO routes'));
    expect(ruta[1][5]).toBe('aleatorio_con_anclas');
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('route_checkpoints'));
    expect(inserts.map((c) => c[1][5])).toEqual([true, false]); // is_anchor
  });

  it('la exigencia de foto solo se actualiza si el punto pertenece al recinto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }]);
    await servicio(query).createRoute('site-id', SUPERVISOR, {
      name: 'Fotográfica', estimatedDurationMin: 12,
      checkpoints: [
        { checkpointId: 'cp-1', requiresPhoto: true },
        { checkpointId: 'cp-2', requiresPhoto: false },
      ],
    });
    const updates = query.mock.calls.filter(([sql]) => sql.includes('UPDATE checkpoints'));
    expect(updates.map((call) => call[1])).toEqual([
      ['cp-1', 'site-id', true], ['cp-2', 'site-id', false],
    ]);
    expect(updates[0]?.[0]).toContain('site_id = $2');
  });

  it('dos puntos de cierre marcados es un error, no una adivinanza', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ present: true }]);
    await expect(
      servicio(query).createRoute('site-id', SUPERVISOR, {
        name: 'x',
        estimatedDurationMin: 30,
        checkpoints: [
          { checkpointId: 'cp-1', isClosingPoint: true },
          { checkpointId: 'cp-2', isClosingPoint: true },
        ],
      }),
    ).rejects.toThrow('Solo un punto puede cerrar la ronda');
  });

  it('cambiar la secuencia sube la version; los campos sueltos no', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 3 }]) // routeSite
      .mockResolvedValueOnce([{ present: true }]) // asignado
      .mockResolvedValueOnce([]); // UPDATE routes
    const r = await servicio(query).updateRoute('route-id', SUPERVISOR, { name: 'Nuevo' });
    expect(r.version).toBe(3);

    const query2 = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 3 }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]) // DELETE secuencia
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([]); // UPDATE routes
    const r2 = await servicio(query2).updateRoute('route-id', SUPERVISOR, {
      checkpoints: [{ checkpointId: 'cp-1' }, { checkpointId: 'cp-2' }],
    });
    expect(r2.version).toBe(4);
  });

  it('updateRoute puede cambiar solo el order_mode, sin subir la version', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 3, order_mode: 'fijo' }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]); // UPDATE routes
    const r = await servicio(query).updateRoute('route-id', SUPERVISOR, {
      orderMode: 'aleatorio',
    });
    expect(r.version).toBe(3);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE routes'));
    expect(update[0]).toContain('order_mode = $2');
    expect(update[1]).toEqual(['route-id', 'aleatorio']);
  });

  it('la ronda congela el snapshot de puntos al asignarla', async () => {
    const query = mocksRonda('fijo', [punto('cp-1'), punto('cp-2', { is_closing_point: true })]);
    const r = await servicio(query).createPatrol('route-id', SUPERVISOR, DTO_RONDA);
    expect(r.expectedCheckpoints).toBe(2);
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO patrols'));
    expect(insert[1][6]).toBe(JSON.stringify(['cp-1', 'cp-2']));
  });

  it('una ventana que termina antes de empezar se rechaza', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 1 }])
      .mockResolvedValueOnce([{ present: true }]);
    await expect(
      servicio(query).createPatrol('route-id', SUPERVISOR, {
        guardId: 'guard-id',
        scheduledStartAt: '2026-08-05T06:00:00Z',
        scheduledEndAt: '2026-08-04T22:00:00Z',
      }),
    ).rejects.toThrow('La ventana termina antes de empezar');
  });
});

describe('SupervisorService.createPatrol — orden aleatorio (#65)', () => {
  const SEIS_PUNTOS = () => [
    punto('cp-1'),
    punto('cp-2'),
    punto('cp-3'),
    punto('cp-4'),
    punto('cp-5'),
    punto('cp-6', { is_closing_point: true }),
  ];
  const ORIGINAL = ['cp-1', 'cp-2', 'cp-3', 'cp-4', 'cp-5', 'cp-6'];

  it('modo aleatorio: el cierre queda al final y dos semillas dan ordenes distintos', async () => {
    conAzar([0]); // Fisher-Yates con j=0 en cada paso
    const queryA = mocksRonda('aleatorio', SEIS_PUNTOS());
    await servicio(queryA).createPatrol('route-id', SUPERVISOR, DTO_RONDA);
    const ordenA = snapshotInsertado(queryA);

    jest.restoreAllMocks();
    conAzar([0.9999]); // j=i en cada paso
    const queryB = mocksRonda('aleatorio', SEIS_PUNTOS());
    await servicio(queryB).createPatrol('route-id', SUPERVISOR, DTO_RONDA);
    const ordenB = snapshotInsertado(queryB);

    // el punto de cierre SIEMPRE al final, en ambos sorteos
    expect(ordenA[ordenA.length - 1]).toBe('cp-6');
    expect(ordenB[ordenB.length - 1]).toBe('cp-6');
    // mismos puntos, ningun faltante ni duplicado
    expect([...ordenA].sort()).toEqual([...ORIGINAL].sort());
    expect([...ordenB].sort()).toEqual([...ORIGINAL].sort());
    // semillas distintas => ordenes distintos: dos rondas del mismo turno en
    // dias distintos no se recorren igual
    expect(ordenA).not.toEqual(ordenB);
  });

  it('aleatorio_con_anclas: las anclas conservan su indice y el cierre va al final', async () => {
    conAzar([0]);
    const query = mocksRonda('aleatorio_con_anclas', [
      punto('cp-1'),
      punto('cp-2', { is_anchor: true }),
      punto('cp-3'),
      punto('cp-4'),
      punto('cp-5', { is_closing_point: true }),
    ]);
    await servicio(query).createPatrol('route-id', SUPERVISOR, DTO_RONDA);
    const orden = snapshotInsertado(query);

    expect(orden[1]).toBe('cp-2'); // el ancla no se movio de su posicion
    expect(orden[orden.length - 1]).toBe('cp-5'); // el cierre al final
    expect([...orden].sort()).toEqual(['cp-1', 'cp-2', 'cp-3', 'cp-4', 'cp-5']);
    expect(orden).not.toEqual(['cp-1', 'cp-2', 'cp-3', 'cp-4', 'cp-5']); // los libres si se barajaron
  });

  it('ruta fijo + randomizeRouteOrder=true del tenant: la regla fuerza el sorteo', async () => {
    conAzar([0]);
    const query = mocksRonda('fijo', SEIS_PUNTOS());
    const r = await servicio(query, { randomizeRouteOrder: true }).createPatrol(
      'route-id',
      SUPERVISOR,
      DTO_RONDA,
    );
    const orden = snapshotInsertado(query);

    expect(r.orderMode).toBe('aleatorio');
    expect(orden).not.toEqual(ORIGINAL);
    expect(orden[orden.length - 1]).toBe('cp-6');
    expect([...orden].sort()).toEqual([...ORIGINAL].sort());
  });

  it('ruta fijo sin regla del tenant: el snapshot respeta la secuencia tal cual', async () => {
    const query = mocksRonda('fijo', SEIS_PUNTOS());
    await servicio(query).createPatrol('route-id', SUPERVISOR, DTO_RONDA);
    expect(snapshotInsertado(query)).toEqual(ORIGINAL);
  });
});
