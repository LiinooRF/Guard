import type { PatrolRules } from '@sentrycore/shared';

import { planDeMuestreo } from './gps-rules';
import type { ParametrosTraza } from './traza-analisis';

/*
 * ACA YA NO HAY DEFAULTS.
 *
 * La entrega original de #134 traia un `TRAZA_RULE_DEFAULTS` con los tres
 * numeros y los leia con `reglas.x ?? DEFAULT.x`, porque `rules.ts` todavia no
 * los declaraba. Ya los declara (`gpsTrackGapMinSeconds`,
 * `gpsTrackStopMinSeconds`, `gpsTrackStopRadiusM`), asi que ese objeto era una
 * SEGUNDA verdad sobre el mismo default: el dia que alguien cambie el numero en
 * `rules.ts` y no aca, el panel muestra uno y el servidor aplica otro, sin un
 * solo test en rojo.
 *
 * Por eso se leen directo de `PatrolRules`, igual que hizo #77 con
 * `GPS_RULE_DEFAULTS`: si manana alguien saca una clave del schema, esto deja
 * de compilar, que es exactamente donde queremos enterarnos.
 */

/**
 * Muestras seguidas sin posicion que tiene que poder perderse una traza antes de
 * que el piso de coherencia acepte llamar hueco a un tramo.
 *
 * NO es un numero de negocio y por eso no va a rules.ts: el numero de negocio es
 * `gpsTrackGapMinSeconds`, que el admin configura. Esto es el margen que impide
 * que el umbral quede POR DEBAJO de lo que el propio muestreo produce. Con el
 * piso pegado al intervalo (`max(gap, intervalo)`) alcanzaba un milisegundo de
 * atraso en una muestra para declarar hueco, porque el corte es estricto
 * (`> gapMinSeconds`): dos muestras seguidas perdidas es el minimo que distingue
 * "no llego nada" de "llego tarde".
 */
export const MUESTRAS_PERDIDAS_PARA_HUECO = 2;

/**
 * Umbrales efectivos para analizar una traza, resueltos desde las reglas del
 * recinto.
 *
 * EL PISO DE COHERENCIA, Y NINGUN NUMERO DE NEGOCIO NUEVO
 * -------------------------------------------------------
 * El hueco y la detencion no pueden quedar por debajo de lo que el propio
 * muestreo produce, y el intervalo de referencia NO es `gpsTrackIntervalSeconds`
 * a secas: cuando la bateria baja de `gpsTrackLowBatteryPct`, el producto mismo
 * espacia las muestras a `gpsTrackLowBatteryIntervalSeconds` (300 s por
 * defecto), que es exactamente el default del umbral de hueco. Con el piso
 * anterior —`max(gap, intervaloNormal)` = 300— cada muestra del modo ahorro
 * caia del lado del hueco por cualquier jitter, y un turno entero con el
 * telefono al 14% se publicaba como "recorrido no verificado" justo cuando el
 * ahorro de bateria funciono como fue disenado.
 *
 * Por eso la referencia es el intervalo MAS LARGO que el producto puede producir
 * (normal o ahorro, el que sea mayor) y el piso son
 * `MUESTRAS_PERDIDAS_PARA_HUECO` de esos intervalos. El analisis no sabe en que
 * modo estaba el telefono en cada tramo —esa decision la toma la app y no viaja
 * en `patrol_tracks`—, asi que se toma el caso que no acusa de mas: preferimos
 * no declarar un hueco de 6 minutos antes que declarar 40 huecos falsos.
 *
 * SOBRE LA PRECISION MAXIMA
 * -------------------------
 * Se lee del plan de muestreo (`gpsTrackMaxAccuracyM`, #77), que es EXACTAMENTE
 * la clave que aplica `GeoService.patrolTrack` para su distancia. Antes se leia
 * `mapTrackMaxAccuracyM`, que es la regla de DIBUJO del mapa del informe (#79):
 * como esa si es editable por el admin, bajarla para limpiar el PDF cambiaba la
 * distancia de una de las dos rutas y no de la otra, que es el defecto que este
 * issue vino a cerrar. Ahora las dos rutas leen la misma clave, la promuevan a
 * rules.ts o no.
 */
export function parametrosTraza(rules: PatrolRules): ParametrosTraza {
  const plan = planDeMuestreo(rules);
  // `planDeMuestreo()` ya garantiza que el de ahorro no sea mas corto que el
  // normal; el max() de aca no depende de que siga siendo asi.
  const intervaloReferencia = Math.max(plan.intervalSeconds, plan.lowBatteryIntervalSeconds);
  const piso = intervaloReferencia * MUESTRAS_PERDIDAS_PARA_HUECO;
  return {
    maxAccuracyM: plan.maxAccuracyM,
    gapMinSeconds: Math.max(rules.gpsTrackGapMinSeconds, piso),
    stopMinSeconds: Math.max(rules.gpsTrackStopMinSeconds, piso),
    stopRadiusM: rules.gpsTrackStopRadiusM,
  };
}
