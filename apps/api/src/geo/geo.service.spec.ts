import { patrolRulesSchema } from '@sentrycore/shared';

import { GeoService } from './geo.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

/**
 * Reglas efectivas del producto. Los siete parametros de #77 ya viven en
 * `patrolRulesSchema`, asi que salen del parse como cualquier otro y no hay que
 * inyectarlos a mano.
 */
const reglas = (overrides: Record<string, unknown> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({
      ...patrolRulesSchema.parse({}),
      gpsTrackIntervalSeconds: 60,
      gpsTrackRetentionDays: 90,
      ...overrides,
    }),
  }) as unknown as RulesService;

/**
 * Reglas que dependen del recinto: `effective()` responde distinto segun le
 * llegue o no un siteId. Es lo que distingue "resolvi la cascada del recinto" de
 * "respondi lo del tenant", que con un mock de valor fijo no se puede ver.
 */
const reglasPorRecinto = (
  empresa: Record<string, unknown>,
  recinto: Record<string, unknown>,
) => {
  const effective = jest.fn(async (contexto?: { siteId?: string | null }) => ({
    ...patrolRulesSchema.parse({}),
    ...empresa,
    ...(contexto?.siteId ? recinto : {}),
  }));
  return { servicio: { effective } as unknown as RulesService, effective };
};

function servicio(query: jest.Mock, overrides: Record<string, unknown> = {}) {
  return new GeoService(
    { manager: { query } } as unknown as TenantContextService,
    reglas(overrides),
  );
}

function servicioCon(query: jest.Mock, reglasServicio: RulesService) {
  return new GeoService(
    { manager: { query } } as unknown as TenantContextService,
    reglasServicio,
  );
}

const RONDA_EN_CURSO = {
  id: 'patrol-1',
  // patrols.site_id es NOT NULL desde la migracion 1722524400000: appendTrack lo
  // lee para resolver el plan de muestreo con la cascada del recinto.
  site_id: 'site-1',
  status: 'en_curso',
  started_at: new Date('2026-08-01T10:00:00Z'),
  scheduled_start_at: new Date('2026-08-01T10:00:00Z'),
};

const PUNTO = (minuto: number, latitude = -33.45) => ({
  recordedAt: `2026-08-01T10:0${minuto}:00Z`,
  latitude,
  longitude: -70.66,
});

const sqlDe = (query: jest.Mock): string[] =>
  query.mock.calls.map(([sql]: [string]) => sql);

describe('GeoService — traza y consentimiento (#15, #134)', () => {
  /*
   * Medido en una caminata real de 20 minutos con 94 posiciones (31-08-2026):
   * diez traian un error declarado de mas de 40 m y una de ellas implicaba
   * 41 km/h a pie. En el informe eso es el zigzag que el cliente ve y no
   * entiende, porque el guardia camino derecho.
   *
   * El servidor ya recibe `gpsTrackMaxAccuracyM` en las reglas y ya sabe que
   * velocidad considera imposible: hasta ahora no usaba ninguna de las dos al
   * guardar, solo al DIBUJAR. Guardar basura y taparla al dibujar significa que
   * el kilometraje, el tiempo detenido y los huecos se calculan sobre ella.
   */
  it('descarta la posicion mas imprecisa que el maximo configurado', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'track-1' }]);

    const resultado = await servicio(query, { gpsTrackMaxAccuracyM: 40 }).appendTrack(
      'guard-1',
      'patrol-1',
      [
        { ...PUNTO(1), accuracyM: 12 },
        { ...PUNTO(2), accuracyM: 146 },
      ],
    );

    expect(resultado.stored).toBe(1);
    expect(resultado.imprecise).toBe(1);
  });

  /*
   * La precision declarada no alcanza: hay posiciones que dicen +-15 m y estan
   * a cien metros de donde el guardia realmente iba. Lo que las delata es el
   * salto contra la anterior, no su propio numero.
   */
  it('descarta el salto que implica una velocidad imposible', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'track-1' }]);

    // 0,02 grados de latitud son ~2,2 km. En un minuto serian 133 km/h.
    const resultado = await servicio(query, { impossibleSpeedKmh: 15 }).appendTrack(
      'guard-1',
      'patrol-1',
      [
        { ...PUNTO(1), accuracyM: 10 },
        { ...PUNTO(2, -33.47), accuracyM: 10 },
      ],
    );

    expect(resultado.stored).toBe(1);
    expect(resultado.impossibleJumps).toBe(1);
  });

  it('una caminata normal no pierde ninguna posicion', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    // ~0,0004 grados por minuto son unos 44 m: 2,7 km/h, caminando.
    const resultado = await servicio(query).appendTrack('guard-1', 'patrol-1', [
      { ...PUNTO(1, -33.4500), accuracyM: 12 },
      { ...PUNTO(2, -33.4504), accuracyM: 14 },
      { ...PUNTO(3, -33.4508), accuracyM: 11 },
    ]);

    expect(resultado.stored).toBe(3);
    expect(resultado.imprecise).toBe(0);
    expect(resultado.impossibleJumps).toBe(0);
  });

  it('sin consentimiento vigente NO se guarda traza', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // no hay consentimiento

    await expect(
      servicio(query).appendTrack('guard-1', 'patrol-1', [PUNTO(1)]),
    ).rejects.toThrow('No tienes consentimiento vigente');

    expect(sqlDe(query).some((sql) => sql.includes('INSERT INTO patrol_tracks'))).toBe(false);
  });

  it('con consentimiento vigente guarda el lote completo', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);

    await expect(
      servicio(query).appendTrack('guard-1', 'patrol-1', [PUNTO(1), PUNTO(2), PUNTO(3)]),
    ).resolves.toMatchObject({
      received: 3,
      stored: 3,
      duplicates: 0,
      outsideShift: 0,
      sampleIntervalSeconds: 60,
    });
  });

  it('con el seguimiento apagado en la empresa, no se acumula traza continua', async () => {
    const query = jest.fn();

    await expect(
      servicio(query, { gpsTrackingEnabled: false }).appendTrack('guard-1', 'patrol-1', [
        PUNTO(1),
      ]),
    ).rejects.toThrow('no registra el recorrido');

    expect(query).not.toHaveBeenCalled();
  });

  /**
   * #77: "opcional" no es "apagado". Antes se miraba gpsSharingMandatory aca y la
   * empresa que elegia NO obligar se quedaba sin traza para nadie, incluso para
   * el guardia que si habia aceptado compartir su ubicacion.
   */
  it('con GPS opcional, al guardia que aceptó igual se le registra el recorrido', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }]);

    await expect(
      servicio(query, { gpsSharingMandatory: false }).appendTrack('guard-1', 'patrol-1', [
        PUNTO(1),
      ]),
    ).resolves.toMatchObject({ received: 1, stored: 1 });
  });

  it('fuera de una ronda en curso no se registra ubicación', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([{ ...RONDA_EN_CURSO, status: 'completada' }]);

    await expect(
      servicio(query).appendTrack('guard-1', 'patrol-1', [PUNTO(1)]),
    ).rejects.toThrow('mientras la ronda está en curso');

    expect(sqlDe(query).some((sql) => sql.includes('INSERT INTO patrol_tracks'))).toBe(false);
  });

  it('descarta los puntos anteriores al inicio de la ronda', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);

    const antesDelTurno = { ...PUNTO(1), recordedAt: '2026-08-01T09:50:00Z' };
    await expect(
      servicio(query).appendTrack('guard-1', 'patrol-1', [antesDelTurno, PUNTO(1), PUNTO(2)]),
    ).resolves.toMatchObject({ received: 3, stored: 2, outsideShift: 1 });

    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO patrol_tracks'),
    );
    // params: [patrolId, guardId, instantes[], latitudes[], ...]
    expect(insert[1][2]).toEqual(['2026-08-01T10:01:00Z', '2026-08-01T10:02:00Z']);
  });

  /**
   * El limite de "punto del futuro" era un 5 * 60_000 escrito en este archivo,
   * y es exactamente el mismo concepto que `clockSkewToleranceMin`, que ya es
   * configurable y ya la usa el escaneo (#73). Un telefono con el reloj
   * adelantado es el mismo telefono en los dos flujos: la empresa que sube la
   * tolerancia tiene que verla aplicada tambien aca.
   */
  it('la tolerancia de reloj del futuro sale de la regla, no de un número fijo', async () => {
    const dentroDeDiezMinutos = {
      ...PUNTO(1),
      recordedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };

    // Con la tolerancia por defecto (5 min) el punto viene demasiado adelantado.
    const estricto = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay;

    await expect(
      servicio(estricto).appendTrack('guard-1', 'patrol-1', [dentroDeDiezMinutos]),
    ).resolves.toMatchObject({ received: 1, stored: 0, outsideShift: 1 });
    expect(sqlDe(estricto).some((sql) => sql.includes('INSERT INTO patrol_tracks'))).toBe(false);

    // Subiendo la MISMA regla a 15 minutos, el punto entra.
    const tolerante = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }]);

    await expect(
      servicio(tolerante, { clockSkewToleranceMin: 15 }).appendTrack('guard-1', 'patrol-1', [
        dentroDeDiezMinutos,
      ]),
    ).resolves.toMatchObject({ received: 1, stored: 1, outsideShift: 0 });
  });

  /**
   * `gpsTrackIntervalSeconds` se configura hasta el nivel de recinto. Si este
   * endpoint respondiera el del tenant, el mismo telefono recibiria un intervalo
   * aca y otro por GET /api/geo/policy, con el mismo nombre de campo.
   */
  it('devuelve el plan de muestreo resuelto en la cascada DEL RECINTO', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }]);

    const { servicio: reglasServicio, effective } = reglasPorRecinto(
      { gpsTrackIntervalSeconds: 60, gpsTrackMinDistanceM: 15 },
      { gpsTrackIntervalSeconds: 120, gpsTrackMinDistanceM: 40 },
    );

    const respuesta = await servicioCon(query, reglasServicio).appendTrack(
      'guard-1',
      'patrol-1',
      [PUNTO(1)],
    );

    expect(respuesta.sampleIntervalSeconds).toBe(120);
    expect(respuesta.sampling).toMatchObject({ intervalSeconds: 120, minDistanceM: 40 });
    // El gate del interruptor va sin recinto —es SOLO_EMPRESA y corre antes de
    // leer una fila—; el plan, con el recinto de la ronda.
    expect(effective).toHaveBeenNthCalledWith(1);
    expect(effective).toHaveBeenNthCalledWith(2, { siteId: 'site-1' });
  });

  it('el reenvío del mismo instante dentro del lote no duplica el punto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
      .mockResolvedValueOnce([])  // ultima posicion guardada: no hay
      .mockResolvedValueOnce([{ id: 't1' }]);

    await expect(
      servicio(query).appendTrack('guard-1', 'patrol-1', [PUNTO(1), PUNTO(1)]),
    ).resolves.toMatchObject({ received: 2, stored: 1, duplicates: 1 });
  });
});

describe('GeoService — distancia y duración de la traza', () => {
  // Tres puntos en la misma longitud separados 0.001° de latitud: cada tramo
  // mide 111.19 m, el total 222.39 m. Es el control aritmetico del haversine.
  const filas = [
    {
      recorded_at_device: new Date('2026-08-01T10:00:00Z'),
      latitude: '-33.450000',
      longitude: '-70.660000',
      accuracy_m: '8.50',
      battery_pct: 90,
    },
    {
      recorded_at_device: new Date('2026-08-01T10:02:00Z'),
      latitude: '-33.451000',
      longitude: '-70.660000',
      accuracy_m: null,
      battery_pct: null,
    },
    {
      recorded_at_device: new Date('2026-08-01T10:04:00Z'),
      latitude: '-33.452000',
      longitude: '-70.660000',
      accuracy_m: '12.00',
      battery_pct: 87,
    },
  ];

  it('suma la distancia recorrida y la duración con 3 puntos conocidos', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'completada' },
      ])
      .mockResolvedValueOnce([{ present: true }]) // recinto asignado al supervisor
      .mockResolvedValueOnce(filas)
      // patrolTrack lee ademas los puntos de la ruta: esta prueba mira la
      // distancia, asi que la superposicion va vacia.
      .mockResolvedValue([]);

    const traza = await servicio(query).patrolTrack('patrol-1', {
      sub: 'supervisor-1',
      role: 'SUPERVISOR',
    });

    expect(traza.pointCount).toBe(3);
    expect(traza.lowAccuracyPointCount).toBe(0);
    expect(traza.totalDistanceM).toBeCloseTo(222.4, 1);
    expect(traza.durationMin).toBe(4);
    expect(traza.retentionDays).toBe(90);
    expect(traza.points[0]).toMatchObject({ latitude: -33.45, accuracyM: 8.5, batteryPct: 90 });
  });

  it('devuelve los checkpoints de la ronda formateados con su estado y posición', async () => {
    const checkpointsMock = [
      {
        id: 'cp-1',
        name: 'Acceso Principal',
        position: 1,
        latitude: '-33.450000',
        longitude: '-70.660000',
        kind: 'acceso_critico',
        scanned: true,
      },
      {
        id: 'cp-2',
        name: 'Bodega 1',
        position: 2,
        latitude: null,
        longitude: null,
        kind: 'normal',
        scanned: false,
      },
    ];

    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'en_curso' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce(filas)
      .mockResolvedValueOnce(checkpointsMock);

    const traza = await servicio(query).patrolTrack('patrol-1', {
      sub: 'supervisor-1',
      role: 'SUPERVISOR',
    });

    expect(traza.checkpoints).toHaveLength(2);
    expect(traza.checkpoints[0]).toEqual({
      id: 'cp-1',
      name: 'Acceso Principal',
      position: 1,
      latitude: -33.45,
      longitude: -70.66,
      scanned: true,
      isCritical: true,
    });
    expect(traza.checkpoints[1]).toEqual({
      id: 'cp-2',
      name: 'Bodega 1',
      position: 2,
      latitude: null,
      longitude: null,
      scanned: false,
      isCritical: false,
    });
  });

  /**
   * #77: un fix con 3 km de error en un subterraneo no puede sumar 3 km de
   * recorrido al informe. El punto se devuelve igual —explica el hueco— pero no
   * entra en la cuenta.
   */
  it('el punto con precisión pésima se devuelve pero no suma distancia', async () => {
    const conRuido = [
      filas[0],
      {
        recorded_at_device: new Date('2026-08-01T10:01:00Z'),
        latitude: '-33.480000',
        longitude: '-70.660000',
        accuracy_m: '3000.00',
        battery_pct: 88,
      },
      filas[1],
      filas[2],
    ];
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'completada' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce(conRuido)
      // patrolTrack lee ademas los puntos de la ruta: esta prueba mira la
      // distancia, asi que la superposicion va vacia.
      .mockResolvedValue([]);

    const traza = await servicio(query).patrolTrack('patrol-1', {
      sub: 'supervisor-1',
      role: 'SUPERVISOR',
    });

    expect(traza.pointCount).toBe(4);
    expect(traza.lowAccuracyPointCount).toBe(1);
    expect(traza.totalDistanceM).toBeCloseTo(222.4, 1);
  });

  /**
   * `gpsTrackMaxAccuracyM` es HASTA_RECINTO: el estacionamiento subterraneo
   * necesita mas margen que la porteria. Con el parametro fuera del schema, el
   * override del recinto se descartaba en el parse y todos los recintos median
   * con el mismo 100.
   */
  it('el override de precisión DEL RECINTO decide qué punto suma distancia', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'completada' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce(filas)
      // patrolTrack lee ademas los puntos de la ruta.
      .mockResolvedValue([]);

    // El recinto exige 10 m; el punto de 12.00 m del medio deja de contar.
    const { servicio: reglasServicio } = reglasPorRecinto(
      { gpsTrackMaxAccuracyM: 100 },
      { gpsTrackMaxAccuracyM: 10 },
    );

    const traza = await servicioCon(query, reglasServicio).patrolTrack('patrol-1', {
      sub: 'supervisor-1',
      role: 'SUPERVISOR',
    });

    expect(traza.maxAccuracyM).toBe(10);
    expect(traza.pointCount).toBe(3);
    // Quedan el primero (8.5 m) y el del medio (sin precision informada): un
    // solo tramo de 111.19 m en vez de los 222.39 m de la serie completa.
    expect(traza.lowAccuracyPointCount).toBe(1);
    expect(traza.totalDistanceM).toBeCloseTo(111.2, 1);
  });

  it('una ronda sin puntos responde traza vacía, no error', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'en_curso' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([])
      // patrolTrack lee ademas los puntos de la ruta.
      .mockResolvedValue([]);

    await expect(
      servicio(query).patrolTrack('patrol-1', { sub: 'supervisor-1', role: 'SUPERVISOR' }),
    ).resolves.toMatchObject({ pointCount: 0, totalDistanceM: 0, durationMin: 0, points: [] });
  });

  it('el supervisor no ve la traza de un recinto que no tiene asignado', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-9', guard_id: 'guard-1', status: 'en_curso' },
      ])
      .mockResolvedValueOnce([]); // sin asignación

    await expect(
      servicio(query).patrolTrack('patrol-1', { sub: 'supervisor-1', role: 'SUPERVISOR' }),
    ).rejects.toThrow('No tienes este recinto asignado');
  });
});

describe('GeoService — consentimiento', () => {
  it('revocar no borra la traza histórica pero impide registrar nuevas', async () => {
    const revocacion = jest.fn().mockResolvedValueOnce([
      { id: 'consent-1', revoked_at: new Date('2026-08-01T12:00:00Z') },
    ]);
    await expect(servicio(revocacion).revokeConsent('guard-1')).resolves.toMatchObject({
      granted: false,
      hadActiveConsent: true,
    });
    // La revocación es un UPDATE de gps_consents y nada mas: la traza no se toca.
    expect(sqlDe(revocacion)).toHaveLength(1);
    expect(sqlDe(revocacion)[0]).toContain('UPDATE gps_consents');
    expect(sqlDe(revocacion).some((sql) => sql.includes('patrol_tracks'))).toBe(false);

    // Desde la revocación, el dispositivo ya no puede agregar puntos.
    const nuevoLote = jest.fn().mockResolvedValueOnce([]);
    await expect(
      servicio(nuevoLote).appendTrack('guard-1', 'patrol-1', [PUNTO(5)]),
    ).rejects.toThrow('No tienes consentimiento vigente');

    // Y lo ya registrado se sigue leyendo.
    const lectura = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'completada' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([
        {
          recorded_at_device: new Date('2026-08-01T10:00:00Z'),
          latitude: '-33.450000',
          longitude: '-70.660000',
          accuracy_m: null,
          battery_pct: null,
        },
      ])
      // patrolTrack lee ademas los puntos de la ruta.
      .mockResolvedValue([]);
    await expect(
      servicio(lectura).patrolTrack('patrol-1', { sub: 'supervisor-1', role: 'SUPERVISOR' }),
    ).resolves.toMatchObject({ pointCount: 1 });
  });

  /**
   * Con el driver de Postgres, `manager.query()` de un UPDATE devuelve
   * [filas, rowCount] y no las filas. Este test NO puede detectarlo (el mock
   * devuelve lo que uno quiera), asi que fija lo unico verificable sin base: que
   * el UPDATE viaja envuelto en un CTE y el comando que se ejecuta es un SELECT.
   */
  it('la revocación envuelve el UPDATE en un CTE para no leer [filas, rowCount]', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    await servicio(query).revokeConsent('guard-1');
    const sql = sqlDe(query)[0]!;
    expect(sql).toContain('WITH revocado AS');
    expect(sql).toContain('SELECT id, revoked_at FROM revocado');
  });

  it('revocar sin consentimiento vigente responde OK: es un derecho, no un trámite', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(servicio(query).revokeConsent('guard-1')).resolves.toMatchObject({
      granted: false,
      revokedAt: null,
      hadActiveConsent: false,
    });
  });

  it('aceptar dos veces la misma versión no genera una fila nueva', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      { id: 'consent-1', granted_at: new Date('2026-07-01T09:00:00Z'), policy_version: 'v1' },
    ]);

    await expect(
      servicio(query).grantConsent('guard-1', { policyVersion: 'v1' }),
    ).resolves.toMatchObject({ granted: true, replacedPreviousVersion: false });

    expect(sqlDe(query).some((sql) => sql.includes('INSERT INTO gps_consents'))).toBe(false);
  });

  it('una versión nueva del texto cierra el consentimiento anterior y abre otro', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'consent-1', granted_at: new Date('2026-07-01T09:00:00Z'), policy_version: 'v1' },
      ])
      .mockResolvedValueOnce([]) // UPDATE de revocación
      .mockResolvedValueOnce([{ id: 'consent-2', granted_at: new Date('2026-08-01T09:00:00Z') }]);

    await expect(
      servicio(query).grantConsent('guard-1', { policyVersion: 'v2', deviceInfo: 'Moto G54' }),
    ).resolves.toMatchObject({
      granted: true,
      policyVersion: 'v2',
      replacedPreviousVersion: true,
    });

    expect(sqlDe(query)[1]).toContain('UPDATE gps_consents');
    expect(sqlDe(query)[2]).toContain('INSERT INTO gps_consents');
  });

  it('el estado informa a la app si debe muestrear, cada cuánto y en qué modo', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        id: 'consent-1',
        granted_at: new Date('2026-08-01T09:00:00Z'),
        revoked_at: null,
        policy_version: 'v1',
        device_info: 'Moto G54',
      },
    ]);

    await expect(servicio(query).consentStatus('guard-1')).resolves.toMatchObject({
      granted: true,
      policyVersion: 'v1',
      trackingEnabled: true,
      sharingMode: 'obligatorio',
      siteId: null,
      sampleIntervalSeconds: 60,
      retentionDays: 90,
    });
  });

  /**
   * Mismo campo, una sola verdad: si la app dice desde que recinto pregunta,
   * `sampleIntervalSeconds` sale de la misma cascada que responde
   * GET /api/geo/policy. Sin recinto sigue siendo el de la empresa, que es lo
   * mas especifico que se puede afirmar cuando la pantalla se abre sin ronda.
   */
  it('con recinto, el estado responde el intervalo resuelto en ese recinto', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { servicio: reglasServicio, effective } = reglasPorRecinto(
      { gpsTrackIntervalSeconds: 60 },
      { gpsTrackIntervalSeconds: 240 },
    );

    await expect(
      servicioCon(query, reglasServicio).consentStatus('guard-1', 'site-1'),
    ).resolves.toMatchObject({
      granted: false,
      siteId: 'site-1',
      sampleIntervalSeconds: 240,
    });
    expect(effective).toHaveBeenCalledWith({ siteId: 'site-1' });
  });
});
