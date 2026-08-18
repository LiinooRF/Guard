import { patrolRulesSchema } from '@sentrycore/shared';

import { ConsentService } from './consent.service';
import type { AuditService } from '../audit/audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

/**
 * Reglas efectivas del producto mas los dos parametros que este modulo pide en
 * INTEGRACION.md (consentReacceptOnNewPolicy, consentOffShiftToleranceMin).
 */
const reglas = (overrides: Record<string, unknown> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({
      ...patrolRulesSchema.parse({}),
      consentReacceptOnNewPolicy: true,
      consentOffShiftToleranceMin: 5,
      ...overrides,
    }),
  }) as unknown as RulesService;

const auditoria = () =>
  ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;

function servicio(
  query: jest.Mock,
  overrides: Record<string, unknown> = {},
  audit: AuditService = auditoria(),
) {
  return new ConsentService(
    { manager: { query } } as unknown as TenantContextService,
    reglas(overrides),
    audit,
  );
}

const sqlDe = (query: jest.Mock): string[] =>
  query.mock.calls.map(([sql]: [string]) => sql);

const POLITICA_VIGENTE = {
  id: 'policy-2',
  version: '2026-v2',
  body: 'x'.repeat(400),
  privacy_policy_url: 'https://andina.cl/privacidad',
  published_at: new Date('2026-07-01T12:00:00Z'),
  retired_at: null,
};

const AVISO_VALIDO = {
  version: '2026-v2',
  body: 'x'.repeat(400),
  privacyPolicyUrl: 'https://andina.cl/privacidad',
};

describe('ConsentService — publicación del aviso (#78)', () => {
  it('publicar una versión nueva retira la anterior y cierra los consentimientos viejos', async () => {
    const query = jest
      .fn()
      // 1. ¿existe ya esa version?
      .mockResolvedValueOnce([])
      // 2. la vigente, que hay que retirar
      .mockResolvedValueOnce([{ ...POLITICA_VIGENTE, id: 'policy-1', version: '2025-v1' }])
      // 3. UPDATE sin RETURNING: el driver devuelve [filas, rowCount]
      .mockResolvedValueOnce([[], 1])
      // 4. INSERT ... RETURNING: arreglo plano de filas
      .mockResolvedValueOnce([{ id: 'policy-2', published_at: new Date('2026-08-01T10:00:00Z') }])
      // 5. UPDATE ... RETURNING de gps_consents: [filas, rowCount]
      .mockResolvedValueOnce([[{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], 3])
      // 6. etiqueta del actor para la auditoria
      .mockResolvedValueOnce([{ label: 'Ana Rojas' }]);

    await expect(
      servicio(query).publishPolicy({ sub: 'admin-1' }, AVISO_VALIDO),
    ).resolves.toMatchObject({
      version: '2026-v2',
      replacedVersion: '2025-v1',
      pendingReacceptance: 3,
      reacceptanceEnforced: true,
    });

    const sql = sqlDe(query);
    expect(sql[2]).toContain('UPDATE consent_policies');
    expect(sql[2]).toContain('retired_at = now()');
    expect(sql[3]).toContain('INSERT INTO consent_policies');
    expect(sql[4]).toContain('UPDATE gps_consents');
    // La traza ya registrada NO se toca al publicar un texto nuevo.
    expect(sql.some((linea) => linea.includes('patrol_tracks'))).toBe(false);
  });

  it('cuenta las re-aceptaciones con el rowCount real, no con el largo de la tupla', async () => {
    // Un UPDATE que no afecto ninguna fila devuelve [[], 0]. Leerlo como arreglo
    // plano daria "2" (dos elementos en la tupla), que es el bug que este test
    // existe para atrapar.
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'policy-1', published_at: new Date('2026-08-01T10:00:00Z') }])
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([{ label: 'Ana Rojas' }]);

    await expect(
      servicio(query).publishPolicy({ sub: 'admin-1' }, AVISO_VALIDO),
    ).resolves.toMatchObject({ pendingReacceptance: 0, replacedVersion: null });
  });

  it('reusar el nombre de una versión ya publicada se rechaza', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'policy-1' }]);

    await expect(
      servicio(query).publishPolicy({ sub: 'admin-1' }, AVISO_VALIDO),
    ).rejects.toThrow('Ya publicaste una versión');

    expect(sqlDe(query).some((sql) => sql.includes('INSERT INTO consent_policies'))).toBe(false);
  });

  it('si la empresa apaga la re-aceptación, los consentimientos viejos siguen vigentes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'policy-1', published_at: new Date('2026-08-01T10:00:00Z') }])
      .mockResolvedValueOnce([{ label: 'Ana Rojas' }]);

    await expect(
      servicio(query, { consentReacceptOnNewPolicy: false }).publishPolicy(
        { sub: 'admin-1' },
        AVISO_VALIDO,
      ),
    ).resolves.toMatchObject({ pendingReacceptance: 0, reacceptanceEnforced: false });

    expect(sqlDe(query).some((sql) => sql.includes('UPDATE gps_consents'))).toBe(false);
  });

  it('publicar queda auditado sin volcar el texto ni datos de personas', async () => {
    const audit = auditoria();
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'policy-1', published_at: new Date('2026-08-01T10:00:00Z') }])
      .mockResolvedValueOnce([[], 2])
      .mockResolvedValueOnce([{ label: 'Ana Rojas' }]);

    await servicio(query, {}, audit).publishPolicy({ sub: 'admin-1' }, AVISO_VALIDO);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'consentimiento.aviso_publicado',
        entityType: 'consent_policy',
        entityId: 'policy-1',
      }),
    );
    const registro = (audit.record as jest.Mock).mock.calls[0][0] as { summary: string };
    expect(registro.summary).not.toContain(AVISO_VALIDO.body);
  });
});

describe('ConsentService — la pantalla de consentimiento', () => {
  it('quien aceptó la versión vigente no tiene nada que hacer', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([POLITICA_VIGENTE])
      .mockResolvedValueOnce([
        {
          granted_at: new Date('2026-07-02T09:00:00Z'),
          revoked_at: null,
          policy_version: '2026-v2',
          device_info: 'Moto G54',
        },
      ]);

    await expect(servicio(query).currentPolicy('guard-1')).resolves.toMatchObject({
      hasPolicy: true,
      actionRequired: 'ninguna',
      acceptance: { status: 'vigente' },
      tracking: { sampleIntervalSeconds: 60, retentionDays: 90 },
    });
  });

  it('quien aceptó un texto anterior tiene que volver a aceptar', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([POLITICA_VIGENTE])
      .mockResolvedValueOnce([
        {
          granted_at: new Date('2025-01-02T09:00:00Z'),
          revoked_at: null,
          policy_version: '2025-v1',
          device_info: null,
        },
      ]);

    await expect(servicio(query).currentPolicy('guard-1')).resolves.toMatchObject({
      actionRequired: 'reaceptar',
      acceptance: { status: 'desactualizado', acceptedVersion: '2025-v1' },
    });
  });

  it('sin aviso publicado la interfaz no puede pedir consentimiento', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(servicio(query).currentPolicy('guard-1')).resolves.toMatchObject({
      hasPolicy: false,
      policy: null,
      actionRequired: 'publicar_aviso',
      acceptance: { status: 'nunca_aceptado' },
    });
  });

  it('el aviso entrega el texto completo, no un identificador', async () => {
    const query = jest.fn().mockResolvedValueOnce([POLITICA_VIGENTE]).mockResolvedValueOnce([]);

    const respuesta = await servicio(query).currentPolicy('guard-1');
    expect(respuesta.policy?.body).toBe(POLITICA_VIGENTE.body);
    expect(respuesta.policy?.privacyPolicyUrl).toBe('https://andina.cl/privacidad');
  });
});

describe('ConsentService — registro por trabajador', () => {
  it('muestra a quien falta, no solo a quien aceptó', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([POLITICA_VIGENTE])
      .mockResolvedValueOnce([
        {
          user_id: 'u1',
          nombre: 'Luis Pérez',
          role_key: 'GUARDIA',
          is_active: true,
          granted_at: null,
          revoked_at: null,
          policy_version: null,
          device_info: null,
        },
        {
          user_id: 'u2',
          nombre: 'Ana Soto',
          role_key: 'GUARDIA',
          is_active: true,
          granted_at: new Date('2026-07-03T09:00:00Z'),
          revoked_at: null,
          policy_version: '2026-v2',
          device_info: 'Moto G54',
        },
        {
          user_id: 'u3',
          nombre: 'Juan Díaz',
          role_key: 'SUPERVISOR',
          is_active: true,
          granted_at: new Date('2025-02-03T09:00:00Z'),
          revoked_at: null,
          policy_version: '2025-v1',
          device_info: null,
        },
        {
          user_id: 'u4',
          nombre: 'Rosa Lagos',
          role_key: 'GUARDIA',
          is_active: false,
          granted_at: new Date('2026-07-04T09:00:00Z'),
          revoked_at: new Date('2026-07-20T09:00:00Z'),
          policy_version: '2026-v2',
          device_info: null,
        },
      ]);

    await expect(servicio(query).roster()).resolves.toMatchObject({
      currentVersion: '2026-v2',
      summary: { total: 4, current: 1, outdated: 1, revoked: 1, never: 1 },
    });
  });

  it('solo pregunta por los roles que operan desde la app', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await servicio(query).roster();

    const [, parametros] = query.mock.calls[1] as [string, unknown[]];
    expect(parametros[0]).toEqual(['SUPERVISOR', 'GUARDIA']);
  });
});

describe('ConsentService — no se rastrea fuera del turno', () => {
  const sinHallazgos = () =>
    jest
      .fn()
      .mockResolvedValueOnce([
        {
          puntos: '1240',
          rondas: '37',
          guardias: '9',
          antes_de_inicio: '0',
          despues_de_cierre: '0',
          sin_consentimiento: '0',
        },
      ])
      .mockResolvedValueOnce([]);

  it('un periodo limpio responde compliant con la lista de hallazgos vacía', async () => {
    await expect(
      servicio(sinHallazgos()).offShiftAudit({ from: '2026-07-01', to: '2026-07-31' }),
    ).resolves.toMatchObject({
      compliant: true,
      summary: { points: 1240, patrols: 37, outsideShift: 0, withoutConsent: 0 },
      findings: [],
    });
  });

  it('acota el periodo en la zona del RECINTO y suma el día antes de convertir', async () => {
    const query = sinHallazgos();
    await servicio(query).offShiftAudit({ from: '2026-07-01', to: '2026-07-31' });

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain(`(($1::date)::timestamp AT TIME ZONE s.timezone)`);
    expect(sql).toContain(`((($2::date + 1)::timestamp) AT TIME ZONE s.timezone)`);
    // El dia local del hallazgo también sale de la zona del recinto, y viaja
    // como texto para que no se corra al serializarlo.
    expect(sql).toContain('AT TIME ZONE s.timezone)::date AS fecha_local');
    const [sqlDetalle] = query.mock.calls[1] as [string];
    expect(sqlDetalle).toContain(`to_char(fecha_local, 'YYYY-MM-DD')`);
  });

  it('un punto anterior al inicio de la ronda aparece como hallazgo del día del recinto', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          puntos: '900',
          rondas: '20',
          guardias: '5',
          antes_de_inicio: '4',
          despues_de_cierre: '0',
          sin_consentimiento: '2',
        },
      ])
      .mockResolvedValueOnce([
        {
          site_id: 'site-1',
          site_name: 'Bodega Norte',
          site_timezone: 'America/Santiago',
          dia_local: '2026-07-14',
          puntos: '120',
          antes_de_inicio: '4',
          despues_de_cierre: '0',
          sin_consentimiento: '2',
        },
      ]);

    await expect(
      servicio(query).offShiftAudit({ from: '2026-07-01', to: '2026-07-31' }),
    ).resolves.toMatchObject({
      compliant: false,
      summary: { beforeStart: 4, afterClose: 0, outsideShift: 4, withoutConsent: 2 },
      findings: [{ siteName: 'Bodega Norte', localDate: '2026-07-14', beforeStart: 4 }],
    });
  });

  it('usa la tolerancia de reloj configurada, no un número escrito en el código', async () => {
    const query = sinHallazgos();
    await servicio(query, { consentOffShiftToleranceMin: 12 }).offShiftAudit({
      from: '2026-07-01',
      to: '2026-07-31',
    });

    const [, parametros] = query.mock.calls[0] as [string, unknown[]];
    expect(parametros[2]).toBe(12);
  });

  it('un rango al revés se rechaza antes de tocar la base', async () => {
    const query = jest.fn();
    await expect(
      servicio(query).offShiftAudit({ from: '2026-07-31', to: '2026-07-01' }),
    ).rejects.toThrow('posterior a la de término');
    expect(query).not.toHaveBeenCalled();
  });
});
