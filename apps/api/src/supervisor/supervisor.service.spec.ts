import { DEFAULT_PATROL_RULES, type PatrolRules } from '@sentrycore/shared';

import { SupervisorService } from './supervisor.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { AuditService } from '../audit/audit.service';

const SUPERVISOR = 'supervisor-id';

function servicio(query: jest.Mock, reglas: Partial<PatrolRules> = {}) {
  const rules = {
    effective: jest.fn().mockResolvedValue({ ...DEFAULT_PATROL_RULES, ...reglas }),
  } as unknown as RulesService;
  return new SupervisorService(
    { manager: { query } } as unknown as TenantContextService,
    rules,
    { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
  );
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

  it('avisa un solapamiento antes de guardar la asignacion', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-id' }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'guard-id' }])
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([
        { assignment_id: 'assignment-id', shift_name: 'Noche', service_date: '2026-08-03', visible_to_supervisor: true },
      ]);

    await expect(
      servicio(query).assignShift('shift-id', SUPERVISOR, {
        guardId: 'guard-id',
        serviceDate: '2026-08-03',
      }),
    ).rejects.toThrow('las ventanas se solapan');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO shift_assignments'))).toBe(
      false,
    );
  });

  it('serializa por guardia y fecha y permite ventanas contiguas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-id' }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'guard-id' }])
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([]) // no hay solapamiento
      .mockResolvedValueOnce([{ id: 'assignment-id' }]);

    await expect(
      servicio(query).assignShift('shift-id', SUPERVISOR, {
        guardId: 'guard-id',
        serviceDate: '2026-08-03',
      }),
    ).resolves.toMatchObject({ id: 'assignment-id' });
    expect(query.mock.calls[3]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[4]?.[0]).toContain("tstzrange(solicitada.inicio, solicitada.fin, '[)')");
    expect(query.mock.calls[4]?.[1]).toEqual([
      'shift-id', '2026-08-03', 'guard-id', null, SUPERVISOR,
    ]);
  });
});

describe('SupervisorService — calendario semanal (#96)', () => {
  it('lista solo los recintos activos asignados al supervisor', async () => {
    // El mock devuelve las columnas que la consulta pide DE VERDAD, incluidas
    // las coordenadas, que llegan como texto desde el driver (numeric) y salen
    // como numeros porque el mapa las necesita asi.
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: 'site-1',
        name: 'Planta',
        branch_name: 'Norte',
        address: 'Ruta 5 km 12',
        timezone: 'America/Santiago',
        latitude: '-33.450000',
        longitude: '-70.660000',
      },
    ]);
    await expect(servicio(query).listAssignedSites(SUPERVISOR)).resolves.toEqual([
      {
        id: 'site-1',
        name: 'Planta',
        branchName: 'Norte',
        address: 'Ruta 5 km 12',
        timezone: 'America/Santiago',
        latitude: -33.45,
        longitude: -70.66,
      },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('supervisor_sites'), [SUPERVISOR]);
    expect(query.mock.calls[0]?.[0]).toContain('s.is_active');
    // El JOIN cruza tambien tenant_id: el aislamiento no queda solo en RLS.
    expect(query.mock.calls[0]?.[0]).toContain('s.tenant_id = ss.tenant_id');
  });

  it('el calendario queda limitado al recinto asignado y a siete fechas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ id: 'a-1', shift_id: 's-1', shift_name: 'Noche',
        starts_at: '22:00:00', ends_at: '06:00:00', service_date: '2026-08-03',
        guard_id: 'g-1', guard_name: 'Gina Guardia', status: 'asignado',
        route_id: 'r-1', route_name: 'Perímetro' }]);
    const result = await servicio(query).weeklySchedule('site-id', SUPERVISOR, '2026-08-03');
    expect(result[0]).toMatchObject({ id: 'a-1', guardName: 'Gina Guardia', routeName: 'Perímetro' });
    expect(query.mock.calls[1]?.[0]).toContain('a.service_date < $2::date + 7');
    expect(query.mock.calls[1]?.[1]).toEqual(['site-id', '2026-08-03']);
  });

  it('la prevalidacion informa el choque sin insertar ni modificar', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', weekday_ok: true }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'guard-id' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ assignment_id: 'a-1', shift_name: 'Día', service_date: '2026-08-03', visible_to_supervisor: true }]);
    await expect(servicio(query).checkShiftConflict('shift-id', SUPERVISOR, {
      guardId: 'guard-id', serviceDate: '2026-08-03',
    })).resolves.toMatchObject({ conflict: true, message: expect.stringContaining('se solapan') });
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it('detecta un choque ajeno sin revelar turno ni fecha de otro recinto', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', weekday_ok: true }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'guard-id' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        assignment_id: 'a-externa',
        shift_name: 'Secreto otra planta',
        service_date: '2026-08-03',
        visible_to_supervisor: false,
      }]);

    const result = await servicio(query).checkShiftConflict('shift-id', SUPERVISOR, {
      guardId: 'guard-id', serviceDate: '2026-08-03',
    });
    expect(result).toEqual({
      conflict: true,
      message: 'El guardia ya tiene un turno asignado en ese horario; las ventanas se solapan',
    });
    expect(result.message).not.toContain('Secreto');
    expect(result.message).not.toContain('2026-08-03');
  });

  it('reasigna solo una asignacion futura y excluye esa fila del control de choque', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ shift_id: 'shift-id', site_id: 'site-id', service_date: '2026-08-03', status: 'asignado' }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'new-guard' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(servicio(query).reassignShift('assignment-id', SUPERVISOR, 'new-guard'))
      .resolves.toEqual({ id: 'assignment-id', guardId: 'new-guard' });
    expect(query.mock.calls[4]?.[1]).toEqual([
      'shift-id', '2026-08-03', 'new-guard', 'assignment-id', SUPERVISOR,
    ]);
    expect(query.mock.calls[5]?.[0]).toContain('UPDATE shift_assignments');
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

  it('listGuards devuelve los guardias con su nfcCardUid', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ present: true }]) // ensureAssignedSite
      .mockResolvedValueOnce([
        { id: 'guard-1', given_name: 'Juan', family_name: 'Pérez', nfc_card_uid: '04A1B2C3D4', tiene_pin: true },
        { id: 'guard-2', given_name: 'Ana', family_name: 'Gómez', nfc_card_uid: null, tiene_pin: false },
      ]);
    const guards = await servicio(query).listGuards('site-id', SUPERVISOR);
    expect(guards).toEqual([
      // `tienePin` dice SI tiene PIN configurado; el hash no sale del servidor.
      { id: 'guard-1', name: 'Juan Pérez', nfcCardUid: '04A1B2C3D4', tienePin: true },
      { id: 'guard-2', name: 'Ana Gómez', nfcCardUid: null, tienePin: false },
    ]);
  });

  it('assignGuardNfcCard normaliza y actualiza la tarjeta NFC del guardia', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'guard-1' }]) // guardia activo existe
      .mockResolvedValueOnce([{ site_id: 'site-1' }]) // supervisor tiene recintos
      .mockResolvedValueOnce([]); // UPDATE users
    const result = await servicio(query).assignGuardNfcCard('guard-1', SUPERVISOR, {
      nfcCardUid: '04:a1:b2:c3:d4',
    });
    // Sin `nfcPin` en la peticion, el PIN NO se toca: por eso `tienePin` queda
    // indefinido y el UPDATE recibe `false` en el parametro que lo gobierna.
    expect(result).toEqual({ id: 'guard-1', nfcCardUid: '04A1B2C3D4', tienePin: undefined });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
      ['guard-1', '04A1B2C3D4', false, null],
    );
  });

  it('assignGuardNfcCard guarda el PIN HASHEADO, nunca en claro', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'guard-1' }])
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([]);
    const result = await servicio(query).assignGuardNfcCard('guard-1', SUPERVISOR, {
      nfcCardUid: '04A1B2C3D4',
      nfcPin: '4821',
    });
    expect(result).toEqual({ id: 'guard-1', nfcCardUid: '04A1B2C3D4', tienePin: true });
    const parametros = query.mock.calls.at(-1)?.[1] as unknown[];
    expect(parametros[2]).toBe(true);
    // Lo que viaja a la base es un hash argon2id, y el PIN no aparece por ningun lado.
    expect(String(parametros[3])).toMatch(/^\$argon2id\$/);
    expect(String(parametros[3])).not.toContain('4821');
  });

  it('assignGuardNfcCard con PIN vacio lo QUITA: ese guardia vuelve a entrar solo con la tarjeta', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'guard-1' }])
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([]);
    const result = await servicio(query).assignGuardNfcCard('guard-1', SUPERVISOR, {
      nfcCardUid: '04A1B2C3D4',
      nfcPin: null,
    });
    expect(result).toEqual({ id: 'guard-1', nfcCardUid: '04A1B2C3D4', tienePin: false });
    const parametros = query.mock.calls.at(-1)?.[1] as unknown[];
    expect(parametros[2]).toBe(true);
    expect(parametros[3]).toBeNull();
  });

  it('assignGuardNfcCard rechaza si el supervisor no tiene recintos asignados', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'guard-1' }]) // guardia activo existe
      .mockResolvedValueOnce([]); // supervisor sin recintos
    await expect(
      servicio(query).assignGuardNfcCard('guard-1', SUPERVISOR, { nfcCardUid: '04A1B2C3D4' }),
    ).rejects.toThrow('No tienes recintos asignados para gestionar guardias');
  });
});
