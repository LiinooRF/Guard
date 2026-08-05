import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EvidenceService } from '../evidence/evidence.service';
import type { RulesService } from '../rules/rules.service';
import { HorarioHabilService } from './horario-habil.service';

/**
 * Pruebas de la comprobacion de horario habil (#68).
 *
 * Los mocks devuelven FILAS porque todas las consultas de este servicio son
 * SELECT. Si alguna fuera UPDATE o DELETE el driver devolveria [filas, rowCount]
 * y un mock con `[{...}]` estaria mintiendo: aca no hay ninguna escritura.
 *
 * Orden de las consultas en comprobar():
 *   1. momento (zona del recinto)   2. feriado del dia
 *   3. total de tramos              4. tramos del dia y del dia anterior
 *   5. puntos activos
 * isWithinBusinessHours y effective() son mocks aparte.
 */
const reglas = (overrides: Partial<PatrolRules> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({ ...patrolRulesSchema.parse({}), ...overrides }),
  }) as unknown as RulesService;

const evidencia = (within: boolean) =>
  ({ isWithinBusinessHours: jest.fn().mockResolvedValue(within) }) as unknown as EvidenceService;

const servicio = (
  query: jest.Mock,
  evidence: EvidenceService = evidencia(false),
  rules: RulesService = reglas(),
) =>
  new HorarioHabilService(
    { manager: { query } } as unknown as TenantContextService,
    evidence,
    rules,
  );

/** Respuestas por defecto de las cinco consultas, en orden. */
const consultas = (opciones: {
  momento?: Record<string, unknown> | null;
  feriado?: Array<{ name: string | null }>;
  tramos?: number;
  puntos?: Array<{ id: string; name: string; kind: string; requires_photo: boolean | null }>;
} = {}) => {
  const momento =
    opciones.momento === undefined
      ? {
          timezone: 'America/Santiago',
          local_date: '2026-08-08',
          local_time: '03:00',
          weekday: 6,
          momento: new Date('2026-08-08T07:00:00.000Z'),
        }
      : opciones.momento;

  return jest
    .fn()
    .mockResolvedValueOnce(momento ? [momento] : [])
    .mockResolvedValueOnce(opciones.feriado ?? [])
    .mockResolvedValueOnce([{ tramos: opciones.tramos ?? 1 }])
    .mockResolvedValueOnce([{ weekday: 5, opens_at: '22:00', closes_at: '06:00' }])
    .mockResolvedValueOnce(opciones.puntos ?? []);
};

const PUNTOS_NORMALES = [
  { id: 'cp-1', name: 'Portón norte', kind: 'normal', requires_photo: null },
  { id: 'cp-2', name: 'Bodega', kind: 'normal', requires_photo: null },
  { id: 'cp-3', name: 'Acceso principal', kind: 'acceso_critico', requires_photo: null },
];

beforeEach(() => jest.clearAllMocks());

describe('HorarioHabilService.comprobar', () => {
  it('sábado de madrugada fuera de horario: todos los puntos exigen foto', async () => {
    const query = consultas({ puntos: PUNTOS_NORMALES });

    const resultado = await servicio(query, evidencia(false)).comprobar(
      'site-1',
      '2026-08-08',
      '03:00',
    );

    expect(resultado.withinBusinessHours).toBe(false);
    expect(resultado.checkpoints).toEqual({ total: 3, requirePhoto: 3, exempt: [] });
    expect(resultado.localDate).toBe('2026-08-08');
    expect(resultado.weekday).toBe(6);
  });

  it('dentro de horario solo exigen foto los accesos críticos', async () => {
    const query = consultas({ puntos: PUNTOS_NORMALES });

    const resultado = await servicio(query, evidencia(true)).comprobar('site-1');

    expect(resultado.checkpoints.requirePhoto).toBe(1);
    // Motivo 'reglas', NO 'override': estos dos puntos tienen requires_photo
    // null, o sea nadie les configuro «Foto: nunca». Quedan exentos solo porque
    // ahora es horario habil, y el panel no puede decir otra cosa.
    expect(resultado.checkpoints.exempt).toEqual([
      { name: 'Portón norte', motivo: 'reglas' },
      { name: 'Bodega', motivo: 'reglas' },
    ]);
  });

  it('un punto con «nunca» queda exento aunque sea fuera de horario', async () => {
    // photoRequiredOutsideHours decide si FUERA de horario la foto es
    // obligatoria en todo punto; el override del punto gana igual, en las dos
    // direcciones. Que el veredicto del panel diga "todos" cuando no es todos
    // seria una promesa falsa.
    const query = consultas({
      puntos: [
        ...PUNTOS_NORMALES,
        { id: 'cp-4', name: 'Sala eléctrica', kind: 'normal', requires_photo: false },
      ],
    });

    const resultado = await servicio(query, evidencia(false)).comprobar('site-1');

    expect(resultado.checkpoints).toEqual({
      total: 4,
      requirePhoto: 3,
      // Este si tiene override propio (requires_photo = false), y es el unico
      // caso en que el panel puede hablar de «Foto: nunca» configurado.
      exempt: [{ name: 'Sala eléctrica', motivo: 'override' }],
    });
  });

  it('con photoRequiredOutsideHours apagada, fuera de horario no se exige foto en todo', async () => {
    const query = consultas({ puntos: PUNTOS_NORMALES });

    const resultado = await servicio(
      query,
      evidencia(false),
      reglas({ photoRequiredOutsideHours: false }),
    ).comprobar('site-1');

    // Solo queda el acceso critico, por photoRequiredOnCritical.
    expect(resultado.checkpoints.requirePhoto).toBe(1);
    expect(resultado.rules.photoRequiredOutsideHours).toBe(false);
    // Exentos FUERA de horario y sin ningun override: el motivo sigue siendo la
    // regla, no una configuracion del punto.
    expect(resultado.checkpoints.exempt).toEqual([
      { name: 'Portón norte', motivo: 'reglas' },
      { name: 'Bodega', motivo: 'reglas' },
    ]);
  });

  it('un feriado se informa como tal y el recinto cuenta como configurado', async () => {
    const query = consultas({
      feriado: [{ name: 'Cierre por mantención' }],
      tramos: 0,
      puntos: PUNTOS_NORMALES,
    });

    const resultado = await servicio(query, evidencia(false)).comprobar('site-1');

    expect(resultado.holiday).toEqual({ date: '2026-08-08', name: 'Cierre por mantención' });
    expect(resultado.hasSchedule).toBe(true);
  });

  it('sin horario ni feriado avisa que el veredicto lo decidió la regla del tenant', async () => {
    const query = consultas({ tramos: 0 });

    const resultado = await servicio(query, evidencia(true)).comprobar('site-1');

    expect(resultado.hasSchedule).toBe(false);
    expect(resultado.rules.businessHoursDefaultOpen).toBe(true);
  });

  it('la conversión de hora local a instante la hace Postgres, no el servidor', async () => {
    const query = consultas();
    const evidence = evidencia(false);

    await servicio(query, evidence).comprobar('site-1', '2026-08-08', '03:00');

    const [sql, parametros] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('AT TIME ZONE');
    // El dia se suma al timestamp SIN zona ($2::date + $3::time) y recien
    // despues se convierte con sites.timezone.
    expect(String(sql)).toContain('$2::date + $3::time');
    expect(parametros).toEqual(['site-1', '2026-08-08', '03:00']);
    // El instante evaluado es el que devolvio la base, no uno armado en JS.
    expect(evidence.isWithinBusinessHours).toHaveBeenCalledWith(
      'site-1',
      new Date('2026-08-08T07:00:00.000Z'),
    );
  });

  it('sin fecha ni hora comprueba el momento actual del recinto', async () => {
    const query = consultas();

    await servicio(query).comprobar('site-1');

    expect(query.mock.calls[0]?.[1]).toEqual(['site-1', null, null]);
    expect(String(query.mock.calls[0]?.[0])).toContain('now() AT TIME ZONE s.timezone');
  });

  it('fecha sin hora es un 400, no una comprobación de medianoche', async () => {
    const query = consultas();

    await expect(servicio(query).comprobar('site-1', '2026-08-08')).rejects.toThrow(
      'Manda fecha y hora juntas',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('recinto inexistente o de otra empresa: 404, no un veredicto inventado', async () => {
    const query = consultas({ momento: null });

    await expect(servicio(query).comprobar('site-x')).rejects.toThrow('El recinto no existe');
  });

  it('el conteo de tramos llega como texto desde el driver y no rompe hasSchedule', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          timezone: 'America/Santiago',
          local_date: '2026-08-08',
          local_time: '03:00',
          weekday: 6,
          momento: new Date('2026-08-08T07:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tramos: '2' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const resultado = await servicio(query).comprobar('site-1');

    expect(resultado.hasSchedule).toBe(true);
  });
});
