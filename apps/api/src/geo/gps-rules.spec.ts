import {
  DEFAULT_PATROL_RULES,
  PATROL_RULE_CATALOG,
  patrolRulesSchema,
  resolveRules,
  type PatrolRules,
} from '@voxia/shared';

import { MAX_PUNTOS_POR_LOTE, planDeMuestreo } from './gps-rules';

/** Los siete que este issue saco del default local de gps-rules.ts. */
const PROMOVIDOS = [
  'gpsTrackMinDistanceM',
  'gpsTrackMaxAccuracyM',
  'gpsTrackBatchSize',
  'gpsTrackLowBatteryPct',
  'gpsTrackLowBatteryIntervalSeconds',
  'gpsBatteryBudgetPct',
  'gpsPermissionReportMaxAgeMin',
] as const;

/** Un valor valido y DISTINTO del default, para que el test no pase por empate. */
const OTRO_VALOR: Record<(typeof PROMOVIDOS)[number], number> = {
  gpsTrackMinDistanceM: 40,
  gpsTrackMaxAccuracyM: 25,
  gpsTrackBatchSize: 120,
  gpsTrackLowBatteryPct: 30,
  gpsTrackLowBatteryIntervalSeconds: 900,
  gpsBatteryBudgetPct: 35,
  gpsPermissionReportMaxAgeMin: 1440,
};

const reglas = (overrides: Partial<PatrolRules> = {}): PatrolRules =>
  patrolRulesSchema.parse({ ...overrides });

describe('parametros de GPS promovidos a rules.ts (#77)', () => {
  /**
   * EL BUG QUE ESTE TEST IMPIDE QUE VUELVA.
   *
   * `patrolRulesSchema.parse()` descarta toda clave que el schema no declara, y
   * la cascada termina en un parse. Mientras estos siete vivieron como default
   * local del modulo geo, el admin escribia el override, el panel lo guardaba y
   * el servidor lo tiraba en silencio — sin error y sin log. Que el valor
   * sobreviva a resolveRules() es LA prueba de que la promocion sirvio.
   */
  it.each(PROMOVIDOS)('el override de %s sobrevive a la cascada', (clave) => {
    const valor = OTRO_VALOR[clave];
    expect(valor).not.toBe(DEFAULT_PATROL_RULES[clave]);

    expect(resolveRules({ tenant: { [clave]: valor } })[clave]).toBe(valor);
  });

  it.each(PROMOVIDOS)('%s tiene ficha en el catalogo, con el mismo rango del zod', (clave) => {
    const ficha = PATROL_RULE_CATALOG[clave];
    expect(ficha).toBeDefined();
    expect(ficha.type).toBe('integer');
    expect(ficha.default).toBe(DEFAULT_PATROL_RULES[clave]);

    // El rango del catalogo es el que pinta el control del panel: si se desviara
    // del que valida zod, el admin veria un limite y la API le respondaria otro.
    const campo = patrolRulesSchema.shape[clave];
    expect(campo.safeParse(ficha.min).success).toBe(true);
    expect(campo.safeParse(ficha.max).success).toBe(true);
    expect(campo.safeParse((ficha.min as number) - 1).success).toBe(false);
    expect(campo.safeParse((ficha.max as number) + 1).success).toBe(false);
  });

  /**
   * Los defaults que quedaron en el catalogo son EXACTAMENTE los que aplicaba el
   * modulo antes de la promocion. Un tenant que ya operaba no puede notar el
   * cambio: si alguno se hubiera movido, el dia del deploy todos los telefonos
   * habrian cambiado de plan de muestreo sin que nadie tocara nada.
   */
  it('la promocion no cambio ningun default vigente', () => {
    expect({
      gpsTrackMinDistanceM: DEFAULT_PATROL_RULES.gpsTrackMinDistanceM,
      gpsTrackMaxAccuracyM: DEFAULT_PATROL_RULES.gpsTrackMaxAccuracyM,
      gpsTrackBatchSize: DEFAULT_PATROL_RULES.gpsTrackBatchSize,
      gpsTrackLowBatteryPct: DEFAULT_PATROL_RULES.gpsTrackLowBatteryPct,
      gpsTrackLowBatteryIntervalSeconds: DEFAULT_PATROL_RULES.gpsTrackLowBatteryIntervalSeconds,
      gpsBatteryBudgetPct: DEFAULT_PATROL_RULES.gpsBatteryBudgetPct,
      gpsPermissionReportMaxAgeMin: DEFAULT_PATROL_RULES.gpsPermissionReportMaxAgeMin,
    }).toEqual({
      gpsTrackMinDistanceM: 15,
      gpsTrackMaxAccuracyM: 100,
      gpsTrackBatchSize: 60,
      gpsTrackLowBatteryPct: 15,
      gpsTrackLowBatteryIntervalSeconds: 300,
      gpsBatteryBudgetPct: 20,
      gpsPermissionReportMaxAgeMin: 720,
    });
  });

  /**
   * `packages/shared` no puede importar de `apps/api`, asi que el max del
   * catalogo y el tope del endpoint son dos literales. Este test es lo unico que
   * impide que se separen: si alguien sube el `@ArrayMaxSize` del DTO sin tocar
   * el catalogo, el admin podria configurar un lote que el endpoint rechaza.
   */
  it('el tope de lote del endpoint y el max de gpsTrackBatchSize son el mismo numero', () => {
    expect(PATROL_RULE_CATALOG.gpsTrackBatchSize.max).toBe(MAX_PUNTOS_POR_LOTE);
  });

  /**
   * La trampa que ya confundio a tres personas en tres modulos:
   * `gpsSharingMandatory` es obligatorio vs OPCIONAL, no encendido vs apagado.
   * Son dos claves distintas y ninguna se deriva de la otra.
   */
  it('gpsSharingMandatory y gpsTrackingEnabled son independientes', () => {
    const opcionalPeroRegistrando = reglas({
      gpsSharingMandatory: false,
      gpsTrackingEnabled: true,
    });
    expect(opcionalPeroRegistrando.gpsTrackingEnabled).toBe(true);

    const obligatorioPeroApagado = reglas({
      gpsSharingMandatory: true,
      gpsTrackingEnabled: false,
    });
    expect(obligatorioPeroApagado.gpsTrackingEnabled).toBe(false);
    expect(obligatorioPeroApagado.gpsSharingMandatory).toBe(true);
  });
});

describe('planDeMuestreo', () => {
  it('entrega el plan tal cual lo configuro el admin', () => {
    const plan = planDeMuestreo(
      reglas({
        gpsTrackIntervalSeconds: 30,
        gpsTrackMinDistanceM: 40,
        gpsTrackMaxAccuracyM: 25,
        gpsTrackBatchSize: 120,
        gpsTrackLowBatteryPct: 30,
        gpsTrackLowBatteryIntervalSeconds: 900,
      }),
    );

    expect(plan).toEqual({
      intervalSeconds: 30,
      minDistanceM: 40,
      maxAccuracyM: 25,
      batchSize: 120,
      lowBatteryPct: 30,
      lowBatteryIntervalSeconds: 900,
    });
  });

  it('el lote nunca supera lo que acepta el endpoint de traza', () => {
    // Por encima del max del zod: no llega por la cascada, pero el recorte es la
    // red que evita entregarle al telefono un lote que el endpoint rechazaria.
    const plan = planDeMuestreo({
      ...reglas(),
      gpsTrackBatchSize: MAX_PUNTOS_POR_LOTE + 1_000,
    });
    expect(plan.batchSize).toBe(MAX_PUNTOS_POR_LOTE);
  });

  it('el modo ahorro nunca muestrea mas seguido que el modo normal', () => {
    // Un "ahorro" que gasta MAS bateria justo cuando queda menos seria peor que
    // no tener modo ahorro. El zod acota cada parametro por separado y no puede
    // saber que uno tiene que quedar por encima del otro.
    const plan = planDeMuestreo(
      reglas({ gpsTrackIntervalSeconds: 600, gpsTrackLowBatteryIntervalSeconds: 60 }),
    );
    expect(plan.lowBatteryIntervalSeconds).toBe(600);
  });

  it('con el filtro de distancia en cero se muestrea solo por tiempo', () => {
    expect(planDeMuestreo(reglas({ gpsTrackMinDistanceM: 0 })).minDistanceM).toBe(0);
  });
});
