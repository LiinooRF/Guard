import { patrolRulesSchema } from '@voxia/shared';

import { GeoService } from './geo.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

/**
 * Reglas efectivas del producto mas los dos campos que este modulo pide en
 * INTEGRACION.md (gpsTrackIntervalSeconds, gpsTrackRetentionDays).
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

function servicio(query: jest.Mock, overrides: Record<string, unknown> = {}) {
  return new GeoService(
    { manager: { query } } as unknown as TenantContextService,
    reglas(overrides),
  );
}

const RONDA_EN_CURSO = {
  id: 'patrol-1',
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

  it('si el tenant no exige compartir ubicación, no se acumula traza continua', async () => {
    const query = jest.fn();

    await expect(
      servicio(query, { gpsSharingRequired: false }).appendTrack('guard-1', 'patrol-1', [
        PUNTO(1),
      ]),
    ).rejects.toThrow('no tiene activado el compartir ubicación');

    expect(query).not.toHaveBeenCalled();
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

  it('el reenvío del mismo instante dentro del lote no duplica el punto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'consent-1' }])
      .mockResolvedValueOnce([RONDA_EN_CURSO])
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
      .mockResolvedValueOnce(filas);

    const traza = await servicio(query).patrolTrack('patrol-1', {
      sub: 'supervisor-1',
      role: 'SUPERVISOR',
    });

    expect(traza.pointCount).toBe(3);
    expect(traza.totalDistanceM).toBeCloseTo(222.4, 1);
    expect(traza.durationMin).toBe(4);
    expect(traza.retentionDays).toBe(90);
    expect(traza.points[0]).toMatchObject({ latitude: -33.45, accuracyM: 8.5, batteryPct: 90 });
  });

  it('una ronda sin puntos responde traza vacía, no error', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        { id: 'patrol-1', site_id: 'site-1', guard_id: 'guard-1', status: 'en_curso' },
      ])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]);

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
      ]);
    await expect(
      servicio(lectura).patrolTrack('patrol-1', { sub: 'supervisor-1', role: 'SUPERVISOR' }),
    ).resolves.toMatchObject({ pointCount: 1 });
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

  it('el estado informa a la app si debe muestrear y cada cuánto', async () => {
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
      sampleIntervalSeconds: 60,
      retentionDays: 90,
    });
  });
});
