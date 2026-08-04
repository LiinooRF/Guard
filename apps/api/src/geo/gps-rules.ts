import type { PatrolRules } from '@voxia/shared';

/**
 * Parametros de GPS que este issue (#77) agrega a `packages/shared/src/rules.ts`.
 *
 * POR QUE ESTAN ACA Y NO EN rules.ts
 * ----------------------------------
 * `rules.ts` lo aplica el integrador (ver INTEGRACION.md, seccion "Parametros
 * para rules.ts"). Hasta que los agregue, `patrolRulesSchema.parse()` DESCARTA
 * cualquier clave desconocida, asi que el override que escriba un admin no
 * llegaria: mientras tanto rige el default de aca. El default esta escrito UNA
 * vez —este objeto— y el catalogo de rules.ts debe declarar exactamente el mismo
 * valor. Si hay dos verdades sobre un default, tarde o temprano el panel muestra
 * un numero y el servidor aplica otro.
 *
 * Ninguno de estos valores es una constante de negocio escondida en el codigo:
 * todos son configurables por el admin en cuanto rules.ts los declare, y la
 * lectura de abajo (`?? default`) sigue funcionando igual despues.
 */
export const GPS_RULE_DEFAULTS = {
  /**
   * Metros minimos entre dos puntos para que el telefono registre uno nuevo.
   * Es el ahorro de bateria mas grande de todos: el guardia parado en la garita
   * deja de despertar el GPS. 0 desactiva el filtro.
   */
  gpsTrackMinDistanceM: 15,

  /**
   * Precision peor que esta (en metros) es ruido: no se usa para dibujar ni para
   * sumar distancia. El punto igual se guarda —es evidencia y explica el hueco—,
   * pero no infla los kilometros recorridos con saltos de GPS de subterraneo.
   */
  gpsTrackMaxAccuracyM: 100,

  /**
   * Puntos por envio. Menos envios = menos veces que se enciende la radio, que
   * es el segundo consumo mas grande despues del GPS.
   */
  gpsTrackBatchSize: 60,

  /** Bajo este porcentaje de bateria el telefono pasa a muestreo espaciado. */
  gpsTrackLowBatteryPct: 15,

  /**
   * Intervalo en modo ahorro. Que la ronda termine con traza gruesa es mejor que
   * un telefono apagado a mitad del turno: un guardia sin telefono no puede
   * pedir ayuda.
   */
  gpsTrackLowBatteryIntervalSeconds: 300,

  /**
   * Consumo de bateria aceptable para una ronda completa
   * (`maxPatrolDurationMin`). El criterio de aceptacion del issue habla de 20%
   * en 8 horas; 8 horas es justamente el default de `maxPatrolDurationMin`, asi
   * que la referencia no se repite como numero suelto.
   */
  gpsBatteryBudgetPct: 20,

  /**
   * Minutos que vale el reporte de permiso del telefono. Vencido, se trata como
   * "no reportado": en modo obligatorio eso bloquea el arranque hasta que la app
   * vuelva a confirmar. 720 = un turno.
   */
  gpsPermissionReportMaxAgeMin: 720,
} as const;

/** Los mismos parametros ya resueltos, sin literales. */
export interface GpsRuleValues {
  gpsTrackingEnabled: boolean;
  gpsTrackMinDistanceM: number;
  gpsTrackMaxAccuracyM: number;
  gpsTrackBatchSize: number;
  gpsTrackLowBatteryPct: number;
  gpsTrackLowBatteryIntervalSeconds: number;
  gpsBatteryBudgetPct: number;
  gpsPermissionReportMaxAgeMin: number;
}

/**
 * Tope de puntos por lote. Espejo del `@ArrayMaxSize(500)` de AppendTrackDto: el
 * plan que se le entrega al telefono no puede pedirle un lote que el propio
 * endpoint va a rechazar.
 */
export const MAX_PUNTOS_POR_LOTE = 500;

/**
 * Lee los parametros nuevos de las reglas efectivas, cayendo al default mientras
 * no existan en el schema.
 */
export function gpsRules(rules: PatrolRules): GpsRuleValues {
  const parcial = rules as PatrolRules & Partial<GpsRuleValues>;
  return {
    // Este ya vive en rules.ts (#77): se lee directo, sin default local. Los de
    // abajo siguen cayendo al default mientras no se promuevan.
    gpsTrackingEnabled: rules.gpsTrackingEnabled,
    gpsTrackMinDistanceM:
      parcial.gpsTrackMinDistanceM ?? GPS_RULE_DEFAULTS.gpsTrackMinDistanceM,
    gpsTrackMaxAccuracyM:
      parcial.gpsTrackMaxAccuracyM ?? GPS_RULE_DEFAULTS.gpsTrackMaxAccuracyM,
    gpsTrackBatchSize: parcial.gpsTrackBatchSize ?? GPS_RULE_DEFAULTS.gpsTrackBatchSize,
    gpsTrackLowBatteryPct:
      parcial.gpsTrackLowBatteryPct ?? GPS_RULE_DEFAULTS.gpsTrackLowBatteryPct,
    gpsTrackLowBatteryIntervalSeconds:
      parcial.gpsTrackLowBatteryIntervalSeconds ??
      GPS_RULE_DEFAULTS.gpsTrackLowBatteryIntervalSeconds,
    gpsBatteryBudgetPct: parcial.gpsBatteryBudgetPct ?? GPS_RULE_DEFAULTS.gpsBatteryBudgetPct,
    gpsPermissionReportMaxAgeMin:
      parcial.gpsPermissionReportMaxAgeMin ?? GPS_RULE_DEFAULTS.gpsPermissionReportMaxAgeMin,
  };
}

/** Lo que el telefono necesita saber para muestrear sin quemar la bateria. */
export interface GpsSamplingPlan {
  intervalSeconds: number;
  minDistanceM: number;
  maxAccuracyM: number;
  batchSize: number;
  lowBatteryPct: number;
  lowBatteryIntervalSeconds: number;
}

/**
 * Arma el plan de muestreo desde las reglas efectivas.
 *
 * Las dos correcciones de abajo existen porque una configuracion incoherente del
 * admin no puede terminar en una app que se comporta peor que sin configurar:
 * el lote no supera lo que el endpoint acepta, y el modo ahorro nunca muestrea
 * MAS seguido que el modo normal.
 */
export function planDeMuestreo(rules: PatrolRules): GpsSamplingPlan {
  const gps = gpsRules(rules);
  return {
    intervalSeconds: rules.gpsTrackIntervalSeconds,
    minDistanceM: gps.gpsTrackMinDistanceM,
    maxAccuracyM: gps.gpsTrackMaxAccuracyM,
    batchSize: Math.min(gps.gpsTrackBatchSize, MAX_PUNTOS_POR_LOTE),
    lowBatteryPct: gps.gpsTrackLowBatteryPct,
    lowBatteryIntervalSeconds: Math.max(
      gps.gpsTrackLowBatteryIntervalSeconds,
      rules.gpsTrackIntervalSeconds,
    ),
  };
}
