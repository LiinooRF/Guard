import type { PatrolRules } from '@sentrycore/shared';

/**
 * Plan de muestreo del recorrido (#77).
 *
 * ACA YA NO HAY DEFAULTS
 * ----------------------
 * Hasta este cambio, este archivo tenia un `GPS_RULE_DEFAULTS` con siete
 * numeros y un `gpsRules()` que leia `reglas.x ?? DEFAULT.x`. Ese `??` no era
 * una comodidad: era el sintoma de que las siete claves no estaban declaradas
 * en `patrolRulesSchema`, y `patrolRulesSchema.parse()` DESCARTA las claves que
 * el schema no declara. El admin escribia el override, el panel lo guardaba en
 * la base y el servidor lo tiraba a la basura en silencio — sin error, sin log,
 * sin nada que mirar.
 *
 * Los siete viven ahora en `packages/shared/src/rules.ts`, cada uno con su
 * ficha en `PATROL_RULE_CATALOG`. Por eso aca se leen DIRECTO de `PatrolRules`:
 * si manana alguien saca una del schema, esto deja de compilar, que es
 * exactamente donde queremos enterarnos.
 */

/**
 * Tope de puntos que el endpoint de traza acepta en una llamada.
 *
 * NO es una regla de negocio configurable: es cuanto entra en un request. Lo
 * configurable es `gpsTrackBatchSize`, que dice cuantos junta el telefono, y su
 * max en el catalogo es justamente este numero.
 *
 * Es UNA constante porque el numero aparece en tres lugares —el
 * `@ArrayMaxSize` de AppendTrackDto, el recorte de `planDeMuestreo()` y el max
 * del catalogo— y con tres literales sueltos subir el tope del endpoint dejaba
 * al telefono con el lote capado y ningun test en rojo. Los dos primeros
 * cuelgan de aca; el tercero lo amarra `gps-rules.spec.ts`, porque
 * `packages/shared` no puede importar de `apps/api`.
 */
export const MAX_PUNTOS_POR_LOTE = 500;

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
 * Las dos correcciones de abajo existen porque una configuracion incoherente
 * del admin no puede terminar en una app que se comporta PEOR que sin
 * configurar: el lote no supera lo que el endpoint acepta, y el modo ahorro
 * nunca muestrea mas seguido que el modo normal —que seria un "ahorro" que
 * gasta mas bateria justo cuando queda menos.
 *
 * Los dos recortes siguen siendo necesarios aunque el zod ya acote los rangos:
 * el zod acota cada parametro por separado y no puede saber que uno tiene que
 * quedar por encima del otro.
 */
export function planDeMuestreo(reglas: PatrolRules): GpsSamplingPlan {
  return {
    intervalSeconds: reglas.gpsTrackIntervalSeconds,
    minDistanceM: reglas.gpsTrackMinDistanceM,
    maxAccuracyM: reglas.gpsTrackMaxAccuracyM,
    batchSize: Math.min(reglas.gpsTrackBatchSize, MAX_PUNTOS_POR_LOTE),
    lowBatteryPct: reglas.gpsTrackLowBatteryPct,
    lowBatteryIntervalSeconds: Math.max(
      reglas.gpsTrackLowBatteryIntervalSeconds,
      reglas.gpsTrackIntervalSeconds,
    ),
  };
}
