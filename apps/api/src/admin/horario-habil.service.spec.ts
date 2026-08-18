import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { patrolRulesSchema, type PatrolRules } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EvidenceService } from '../evidence/evidence.service';
import type { RuleContext, RulesService } from '../rules/rules.service';
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
 *   5. puntos activos (con tiene_reglas_propias)
 * isWithinBusinessHours y effective() son mocks aparte.
 */

/**
 * effective() que RESPONDE DISTINTO segun el contexto que se le pasa.
 *
 * El mock anterior devolvia lo mismo con contexto y sin el, asi que la suite se
 * quedo verde mientras el panel resolvia media cascada y prometia foto donde la
 * ronda ya no la pedia. Este ademas revienta si lo llaman sin recinto: en este
 * servicio no queda ninguna llamada legitima sin contexto, y una que aparezca
 * tiene que romper el test, no pasar desapercibida.
 */
const reglas = (
  niveles: {
    tenant?: Partial<PatrolRules>;
    recinto?: Partial<PatrolRules>;
    /** Overrides de checkpoint_rules, por id de punto. */
    puntos?: Record<string, Partial<PatrolRules>>;
  } = {},
) =>
  ({
    effective: jest.fn(async (contexto: RuleContext = {}) => {
      if (!contexto.siteId) {
        throw new Error('effective() sin recinto: el panel resolveria menos cascada que la ronda');
      }
      return {
        ...patrolRulesSchema.parse({}),
        ...niveles.tenant,
        ...niveles.recinto,
        ...(contexto.checkpointId ? niveles.puntos?.[contexto.checkpointId] : undefined),
      };
    }),
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

/** Una fila de la consulta de puntos, con las mismas columnas que el SQL. */
type FilaPunto = {
  id: string;
  name: string;
  kind: string;
  requires_photo: boolean | null;
  tiene_reglas_propias: boolean;
};

/** Respuestas por defecto de las cinco consultas, en orden. */
const consultas = (opciones: {
  momento?: Record<string, unknown> | null;
  feriado?: Array<{ name: string | null }>;
  tramos?: number;
  puntos?: FilaPunto[];
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

const PORTON: FilaPunto = {
  id: 'cp-1',
  name: 'Portón norte',
  kind: 'normal',
  requires_photo: null,
  tiene_reglas_propias: false,
};
const BODEGA: FilaPunto = {
  id: 'cp-2',
  name: 'Bodega',
  kind: 'normal',
  requires_photo: null,
  tiene_reglas_propias: false,
};
const ACCESO: FilaPunto = {
  id: 'cp-3',
  name: 'Acceso principal',
  kind: 'acceso_critico',
  requires_photo: null,
  tiene_reglas_propias: false,
};

const PUNTOS_NORMALES: FilaPunto[] = [PORTON, BODEGA, ACCESO];

/** El mismo punto, pero con fila propia en checkpoint_rules. */
const conReglasPropias = (fila: FilaPunto): FilaPunto => ({ ...fila, tiene_reglas_propias: true });

/** El jest.fn() de adentro del mock, para mirarle las llamadas. */
const llamadas = (rules: RulesService) => (rules.effective as jest.Mock).mock.calls;

beforeEach(() => jest.clearAllMocks());

describe('HorarioHabilService.comprobar', () => {
  it('con la regla de fuera-de-horario ENCENDIDA, de madrugada todos los puntos exigen foto', async () => {
    // La regla viene apagada de fabrica desde el 8-ago (la foto la exige una
    // tarea, no el reloj); este test cubre a la empresa que la enciende.
    const query = consultas({ puntos: PUNTOS_NORMALES });

    const resultado = await servicio(
      query,
      evidencia(false),
      reglas({ tenant: { photoRequiredOutsideHours: true } }),
    ).comprobar('site-1', '2026-08-08', '03:00');

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
        {
          id: 'cp-4',
          name: 'Sala eléctrica',
          kind: 'normal',
          requires_photo: false,
          tiene_reglas_propias: false,
        },
      ],
    });

    const resultado = await servicio(
      query,
      evidencia(false),
      reglas({ tenant: { photoRequiredOutsideHours: true } }),
    ).comprobar('site-1');

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
      reglas({ tenant: { photoRequiredOutsideHours: false } }),
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

  it('el override del recinto manda: donde la ronda dejó de pedir foto, el panel deja de prometerla', async () => {
    // El caso que rompia: tenant con «foto en todo acceso critico» y un recinto
    // que la apaga en site_rules. El panel listaba ese acceso como que exige
    // foto y el guardia escaneaba sin que se la pidieran.
    const query = consultas({ puntos: PUNTOS_NORMALES });
    const rules = reglas({
      tenant: { photoRequiredOnCritical: true },
      recinto: { photoRequiredOnCritical: false },
    });

    const resultado = await servicio(query, evidencia(true), rules).comprobar('site-1');

    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-1' });
    expect(resultado.checkpoints.requirePhoto).toBe(0);
    // Lo que se le muestra al admin es lo del RECINTO, no lo del tenant.
    expect(resultado.rules.photoRequiredOnCritical).toBe(false);
    // Y el motivo apunta al recinto, que es donde se corrige.
    expect(resultado.checkpoints.exempt).toContainEqual({
      name: 'Acceso principal',
      motivo: 'reglas',
    });
  });

  it('el punto con reglas propias se resuelve con SU cascada, la misma que pide el escaneo', async () => {
    const query = consultas({ puntos: [PORTON, BODEGA, conReglasPropias(ACCESO)] });
    const rules = reglas({ puntos: { 'cp-3': { photoRequiredOnCritical: false } } });

    const resultado = await servicio(query, evidencia(true), rules).comprobar('site-1');

    // EvidenceService.requiresPhoto() pregunta {siteId, checkpointId}; el panel
    // pregunta igual o vuelve a prometer lo que la ronda no cumple.
    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-1', checkpointId: 'cp-3' });
    expect(resultado.checkpoints.requirePhoto).toBe(0);
    // Motivo distinto a 'reglas': esto se corrige en el punto, no en el recinto.
    expect(resultado.checkpoints.exempt).toContainEqual({
      name: 'Acceso principal',
      motivo: 'reglas-punto',
    });
  });

  it('no le pregunta la cascada al punto que no tiene reglas propias', async () => {
    const query = consultas({ puntos: [PORTON, BODEGA, conReglasPropias(ACCESO)] });
    const rules = reglas();

    await servicio(query, evidencia(false), rules).comprobar('site-1');

    // Una del recinto y una del unico punto con fila en checkpoint_rules: sin
    // esa fila el veredicto es identico al del recinto y la consulta sobra.
    expect(llamadas(rules)).toEqual([
      [{ siteId: 'site-1' }],
      [{ siteId: 'site-1', checkpointId: 'cp-3' }],
    ]);
  });

  it('reglas propias que no cambian el veredicto no se le cuelgan al punto', async () => {
    const query = consultas({ puntos: [conReglasPropias(PORTON), BODEGA, ACCESO] });
    // El punto tiene lo suyo configurado, pero dentro de horario da lo mismo:
    // un punto normal queda exento igual. El motivo sigue siendo el heredado.
    const rules = reglas({ puntos: { 'cp-1': { photoRequiredOutsideHours: false } } });

    const resultado = await servicio(query, evidencia(true), rules).comprobar('site-1');

    expect(resultado.checkpoints.exempt).toEqual([
      { name: 'Portón norte', motivo: 'reglas' },
      { name: 'Bodega', motivo: 'reglas' },
    ]);
  });

  it('tiene_reglas_propias sale de la consulta, no de una columna inventada en el mock', async () => {
    const query = consultas({ puntos: PUNTOS_NORMALES });

    await servicio(query).comprobar('site-1');

    const [sql] = query.mock.calls[4] ?? [];
    expect(String(sql)).toContain('FROM checkpoint_rules r');
    expect(String(sql)).toContain('AS tiene_reglas_propias');
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

/**
 * El servicio se ahorra la consulta de la cascada en el punto que no tiene fila
 * en checkpoint_rules, y ese atajo vale SOLO mientras esa tabla sea el unico
 * origen del nivel de punto. Es una suposicion sobre otro modulo, asi que se
 * comprueba contra su codigo y no contra un mock: si manana el nivel de punto
 * saca algo de otra parte, el panel volveria a resolver menos cascada que la
 * ronda —en silencio y con la suite verde, que es exactamente como llego el bug
 * que este archivo arregla—. Que caiga este test es la forma de enterarse.
 */
describe('el atajo que se salta la cascada del punto', () => {
  it('sigue valiendo: el nivel de punto sale solo de checkpoint_rules', () => {
    const fuente = readFileSync(join(__dirname, '..', 'rules', 'rules.service.ts'), 'utf8');

    const tablasDelNivelPunto = [
      ...fuente.matchAll(/'checkpoint'\s+AS\s+scope[\s\S]*?FROM\s+(\w+)/g),
    ].map((coincidencia) => coincidencia[1]);

    expect(tablasDelNivelPunto).toEqual(['checkpoint_rules']);
  });
});
