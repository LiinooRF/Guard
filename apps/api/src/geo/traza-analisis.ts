import { haversineM } from './haversine';

/**
 * La traza del recorrido como DATO, no como dibujo (#134).
 *
 * Hasta ahora la traza existia dos veces y como subproducto: GeoService.patrolTrack
 * suma una distancia para el panel y mapa-recorrido.model suma otra para el PDF.
 * Este archivo es la aritmetica de la traza en UN solo lugar, y responde las tres
 * preguntas que el cliente hace mirando el mapa:
 *
 *   - cuanto recorrio de verdad
 *   - donde nos quedamos sin saber donde estaba (huecos de cobertura)
 *   - cuanto tiempo estuvo detenido
 *
 * Es PURO a proposito, igual que mapa-recorrido.model.ts: sin Nest, sin base de
 * datos, sin reloj. Aca vive la aritmetica que se equivoca en silencio —un
 * numeric que llego como string, una resta de fechas, una ventana que se cierra
 * en el punto equivocado— y por eso esta afuera del servicio, donde se puede
 * probar caso por caso.
 *
 * ---------------------------------------------------------------------------
 * LOS PUNTOS IMPRECISOS NO SE BORRAN: EXPLICAN EL HUECO
 * ---------------------------------------------------------------------------
 * Un punto con precision peor que la regla del tenant (`gpsTrackMaxAccuracyM`,
 * la misma que aplica `GeoService.patrolTrack`; ver traza-rules.ts)
 * es ruido para MEDIR: un fix de 2 km de error en un subterraneo agrega
 * kilometros que nadie camino, y ese total termina en el informe del cliente.
 * Pero como EVIDENCIA vale, y mucho: es la diferencia entre "el telefono se
 * apago / lo dejo en la caseta" y "el guardia estaba abajo en el estacionamiento
 * y el GPS no enganchaba". Por eso cada hueco declara cuantas posiciones
 * imprecisas cayeron adentro y una `cause` que distingue esos dos mundos.
 *
 * Ninguna funcion de este archivo descarta filas: las clasifica.
 * ---------------------------------------------------------------------------
 */

/**
 * Fila cruda de `patrol_tracks` (migracion 1724511600000-CreateTrackAndConsent).
 *
 * Los tipos anchos no son pereza: `latitude`/`longitude` son numeric(9,6) y
 * `accuracy_m` numeric(7,2), y el driver de Postgres entrega numeric como
 * STRING. `battery_pct` es smallint y llega como number. Aceptar las dos formas
 * evita que un cambio de cast en la consulta se convierta en NaN silencioso.
 */
export interface FilaTrazaCruda {
  readonly recorded_at_device: Date | string;
  readonly latitude: string | number;
  readonly longitude: string | number;
  readonly accuracy_m: string | number | null;
  readonly battery_pct: string | number | null;
}

export interface PuntoTraza {
  readonly instante: Date;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number | null;
  readonly batteryPct: number | null;
  /**
   * false = precision peor que el maximo del tenant. Se guarda y se cuenta,
   * pero no suma distancia ni define detenciones.
   */
  readonly confiable: boolean;
}

/**
 * Umbrales aplicados. Todos salen de reglas configurables (ver traza-rules.ts):
 * aca no se decide ningun numero, solo se aplica el que llego.
 */
export interface ParametrosTraza {
  /** Precision maxima aceptada para MEDIR con un punto, en metros. */
  readonly maxAccuracyM: number;
  /** Segundos sin una posicion utilizable a partir de los cuales hay hueco. */
  readonly gapMinSeconds: number;
  /** Radio dentro del cual se considera que no se movio, en metros. */
  readonly stopRadiusM: number;
  /** Segundos quieto a partir de los cuales se declara una detencion. */
  readonly stopMinSeconds: number;
}

/**
 * Por que el telefono no entrego posicion utilizable en ese tramo.
 *
 * - `sin_reporte`: no llego NADA. Sin señal, app dormida, telefono apagado o
 *   sin bateria. Es el hueco que hay que explicar.
 * - `precision_insuficiente`: si llegaron posiciones, pero todas con un error
 *   mayor al que el tenant acepta. El telefono estaba trabajando; el GPS no.
 */
export type CausaHueco = 'sin_reporte' | 'precision_insuficiente';

export interface HuecoTraza {
  readonly fromAt: Date;
  readonly toAt: Date;
  readonly minutes: number;
  /**
   * Linea recta entre los dos extremos del hueco, en metros. `null` en los
   * huecos de cabeza y de cola: ahi un extremo es el inicio o el cierre de la
   * ronda, que es un instante y no una posicion.
   */
  readonly straightLineM: number | null;
  /** Posiciones guardadas dentro del hueco que no alcanzaron la precision minima. */
  readonly lowAccuracyPoints: number;
  readonly cause: CausaHueco;
  /** Ultima bateria conocida antes del hueco y primera despues. Explican sin acusar. */
  readonly batteryPctBefore: number | null;
  readonly batteryPctAfter: number | null;
}

export interface DetencionTraza {
  readonly fromAt: Date;
  readonly toAt: Date;
  readonly minutes: number;
  /**
   * Posicion del punto que ancla la ventana, no el promedio de la ventana.
   * Promediar coordenadas se rompe en el antimeridiano y no aporta nada: todos
   * los puntos de la ventana estan dentro de `stopRadiusM` de este.
   */
  readonly latitude: number;
  readonly longitude: number;
  readonly points: number;
}

export interface EntradaTraza {
  readonly filas: readonly FilaTrazaCruda[];
  readonly parametros: ParametrosTraza;
  /**
   * Ventana de la ronda. `desde` = inicio real de la ronda, `hasta` = cierre.
   *
   * Sirve para ver los huecos de CABEZA y de COLA, que son los que mas dicen: la
   * ronda arranco a las 22:00 y la primera posicion llego a las 22:40. Sin esto,
   * una traza que empieza tarde se ve perfecta.
   *
   * Se omiten cuando no se saben (ronda en curso, ronda sin `started_at`): ahi la
   * ventana la definen los propios puntos y no se inventa un hueco.
   */
  readonly desde?: Date | null;
  readonly hasta?: Date | null;
}

export interface AnalisisTraza {
  /** Posiciones guardadas, incluidas las imprecisas. */
  readonly points: number;
  /** Las que sirven para medir. */
  readonly usablePoints: number;
  /** Las que no: se conservan como evidencia y explican los huecos. */
  readonly lowAccuracyPoints: number;
  readonly firstPointAt: Date | null;
  readonly lastPointAt: Date | null;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly windowMinutes: number;
  /**
   * Distancia total, en metros: la suma de los tramos entre posiciones
   * utilizables consecutivas. Es `measuredDistanceM + gapDistanceM`.
   */
  readonly distanceM: number;
  /** La parte medida con posiciones seguidas, sin huecos de por medio. */
  readonly measuredDistanceM: number;
  /**
   * La parte que cruza un hueco: una linea recta entre los dos bordes. Nadie
   * sabe si ese tramo se camino, se hizo en auto o no se hizo. Va separada para
   * que el informe no la presente como recorrido verificado.
   */
  readonly gapDistanceM: number;
  readonly gaps: readonly HuecoTraza[];
  readonly gapCount: number;
  readonly gapMinutes: number;
  readonly longestGapMinutes: number;
  /**
   * Porcentaje de los MINUTOS de la ventana con posicion utilizable. `null` si
   * no hay ventana.
   *
   * Se llama `timeCoveragePct` y no `coveragePct` porque bajo el mismo prefijo
   * `/api/geo` ya existe otro: el `coveragePct` de
   * `GpsPolicyService.siteGpsCoverage` (#77) es el porcentaje de RONDAS que
   * tienen traza. Dos porcentajes distintos con el mismo nombre en la misma
   * pantalla es una discusion con el cliente esperando a ocurrir.
   */
  readonly timeCoveragePct: number | null;
  readonly stops: readonly DetencionTraza[];
  readonly stopCount: number;
  readonly stoppedMinutes: number;
  /** Ventana menos huecos menos detenciones. Nunca negativo. */
  readonly movingMinutes: number;
  /** Los umbrales que se aplicaron, para que el numero se pueda auditar. */
  readonly thresholds: ParametrosTraza;
}

/** Analisis completo de una traza. No consulta nada ni mira el reloj. */
export function analizarTraza(entrada: EntradaTraza): AnalisisTraza {
  const { parametros } = entrada;
  const puntos = normalizar(entrada.filas, parametros.maxAccuracyM);
  const confiables = puntos.filter((punto) => punto.confiable);
  const imprecisos = puntos.filter((punto) => !punto.confiable);

  const primero = puntos[0] ?? null;
  const ultimo = puntos[puntos.length - 1] ?? null;

  // La ventana cubre SIEMPRE todos los puntos guardados. Si el reloj del
  // telefono entrego una posicion posterior al cierre de la ronda, se estira la
  // ventana en vez de dejar puntos fuera y descuadrar los totales.
  const inicio = menor(entrada.desde ?? null, primero?.instante ?? null);
  const fin = mayor(entrada.hasta ?? null, ultimo?.instante ?? null);
  const ventanaMs = inicio && fin ? Math.max(0, fin.getTime() - inicio.getTime()) : 0;

  const huecos = detectarHuecos(puntos, confiables, imprecisos, inicio, fin, parametros);
  const { total, medida, enHuecos } = distancias(confiables, parametros);
  const detenciones = detectarDetenciones(confiables, parametros);

  const minutosHueco = huecos.reduce((suma, hueco) => suma + hueco.minutes, 0);
  const minutosDetenido = detenciones.reduce((suma, parada) => suma + parada.minutes, 0);
  const minutosVentana = ventanaMs / 60_000;

  return {
    points: puntos.length,
    usablePoints: confiables.length,
    lowAccuracyPoints: imprecisos.length,
    firstPointAt: primero?.instante ?? null,
    lastPointAt: ultimo?.instante ?? null,
    windowFrom: inicio,
    windowTo: fin,
    windowMinutes: redondear(minutosVentana),
    distanceM: redondear(total),
    measuredDistanceM: redondear(medida),
    gapDistanceM: redondear(enHuecos),
    gaps: huecos,
    gapCount: huecos.length,
    gapMinutes: redondear(minutosHueco),
    longestGapMinutes: huecos.reduce((max, hueco) => Math.max(max, hueco.minutes), 0),
    timeCoveragePct:
      minutosVentana > 0
        ? redondear(((minutosVentana - minutosHueco) / minutosVentana) * 100)
        : null,
    stops: detenciones,
    stopCount: detenciones.length,
    stoppedMinutes: redondear(minutosDetenido),
    // Piso en cero: los huecos y las detenciones no se solapan por construccion,
    // pero un redondeo no puede terminar publicando tiempo negativo.
    movingMinutes: redondear(Math.max(0, minutosVentana - minutosHueco - minutosDetenido)),
    thresholds: parametros,
  };
}

// ------------------------------------------------------------------ internos

/**
 * Filas crudas -> puntos ordenados y tipados.
 *
 * El orden se rehace aca aunque la consulta lleve ORDER BY: toda la aritmetica
 * de mas abajo asume serie creciente, y una serie desordenada no falla, miente.
 *
 * Una posicion con precision DESCONOCIDA (`accuracy_m` NULL) cuenta como
 * confiable: mismo criterio que GeoService.patrolTrack y que el mapa del
 * informe. El UMBRAL, en cambio, coincide con GeoService.patrolTrack y con nadie
 * mas: los dos leen `gpsTrackMaxAccuracyM` (ver traza-rules.ts), que es lo que
 * evita dos distancias distintas de la misma ronda en el panel. El mapa del PDF
 * filtra con `mapTrackMaxAccuracyM`, que es una regla de DIBUJO y puede dejar
 * fuera del trazo puntos que aca si miden.
 */
function normalizar(
  filas: readonly FilaTrazaCruda[],
  maxAccuracyM: number,
): readonly PuntoTraza[] {
  const puntos: PuntoTraza[] = [];
  for (const fila of filas) {
    const instante = aFecha(fila.recorded_at_device);
    const latitude = aNumero(fila.latitude);
    const longitude = aNumero(fila.longitude);
    // Una fila sin instante o sin coordenada valida solo puede venir de una
    // escritura a mano: se ignora en vez de arrastrar NaN a todos los totales.
    if (!instante || latitude === null || longitude === null) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const accuracyM = aNumero(fila.accuracy_m);
    puntos.push({
      instante,
      latitude,
      longitude,
      accuracyM,
      batteryPct: aNumero(fila.battery_pct),
      confiable: accuracyM === null || accuracyM <= maxAccuracyM,
    });
  }
  return puntos.sort((a, b) => a.instante.getTime() - b.instante.getTime());
}

/**
 * Huecos de cobertura.
 *
 * Se miran los tramos entre posiciones UTILIZABLES consecutivas, mas el tramo
 * de cabeza (inicio de la ronda -> primera utilizable) y el de cola (ultima
 * utilizable -> cierre). Un tramo mas largo que `gapMinSeconds` es un hueco.
 *
 * Sin ninguna posicion utilizable hay un solo hueco: la ronda completa. Y si
 * adentro hubo posiciones imprecisas, la causa lo dice — que es exactamente la
 * diferencia entre un telefono apagado y un subterraneo.
 */
function detectarHuecos(
  puntos: readonly PuntoTraza[],
  confiables: readonly PuntoTraza[],
  imprecisos: readonly PuntoTraza[],
  inicio: Date | null,
  fin: Date | null,
  parametros: ParametrosTraza,
): readonly HuecoTraza[] {
  if (!inicio || !fin) return [];

  const tramos: Array<{ desde: Date; hasta: Date; a: PuntoTraza | null; b: PuntoTraza | null }> = [];
  const primeraUtil = confiables[0] ?? null;
  const ultimaUtil = confiables[confiables.length - 1] ?? null;

  if (!primeraUtil || !ultimaUtil) {
    tramos.push({ desde: inicio, hasta: fin, a: null, b: null });
  } else {
    tramos.push({ desde: inicio, hasta: primeraUtil.instante, a: null, b: primeraUtil });
    for (let i = 1; i < confiables.length; i += 1) {
      const previo = confiables[i - 1]!;
      const actual = confiables[i]!;
      tramos.push({ desde: previo.instante, hasta: actual.instante, a: previo, b: actual });
    }
    tramos.push({ desde: ultimaUtil.instante, hasta: fin, a: ultimaUtil, b: null });
  }

  const huecos: HuecoTraza[] = [];
  for (const tramo of tramos) {
    const segundos = (tramo.hasta.getTime() - tramo.desde.getTime()) / 1000;
    if (segundos <= parametros.gapMinSeconds) continue;

    // El indice unico (tenant_id, patrol_id, recorded_at_device) garantiza que
    // dos puntos no comparten instante, asi que los bordes inclusivos no pueden
    // contar de mas un punto que ya es borde del tramo.
    const adentro = imprecisos.filter(
      (punto) =>
        punto.instante.getTime() >= tramo.desde.getTime() &&
        punto.instante.getTime() <= tramo.hasta.getTime(),
    ).length;

    huecos.push({
      fromAt: tramo.desde,
      toAt: tramo.hasta,
      minutes: redondear(segundos / 60),
      straightLineM:
        tramo.a && tramo.b
          ? redondear(
              haversineM(tramo.a.latitude, tramo.a.longitude, tramo.b.latitude, tramo.b.longitude),
            )
          : null,
      lowAccuracyPoints: adentro,
      cause: adentro > 0 ? 'precision_insuficiente' : 'sin_reporte',
      batteryPctBefore: bateriaEn(puntos, tramo.desde, 'antes'),
      batteryPctAfter: bateriaEn(puntos, tramo.hasta, 'despues'),
    });
  }
  return huecos;
}

/**
 * Distancia por haversine sobre la serie utilizable, separando lo medido de lo
 * que cruza un hueco.
 *
 * Dos posiciones buenas separadas por una mala siguen midiendo el tramo entre
 * ellas: la mala no parte la serie, solo no aporta su vertice.
 */
function distancias(
  confiables: readonly PuntoTraza[],
  parametros: ParametrosTraza,
): { total: number; medida: number; enHuecos: number } {
  let medida = 0;
  let enHuecos = 0;
  for (let i = 1; i < confiables.length; i += 1) {
    const previo = confiables[i - 1]!;
    const actual = confiables[i]!;
    const metros = haversineM(
      previo.latitude,
      previo.longitude,
      actual.latitude,
      actual.longitude,
    );
    if (esSalto(previo, actual, parametros)) enHuecos += metros;
    else medida += metros;
  }
  return { total: medida + enHuecos, medida, enHuecos };
}

/**
 * Detenciones: ventanas seguidas de posiciones que no se alejan mas de
 * `stopRadiusM` del punto que las ancla y que duran al menos `stopMinSeconds`.
 *
 * Un hueco CIERRA la ventana en curso: durante un hueco no se sabe si estuvo
 * quieto o dio la vuelta al recinto, y contarlo como detencion seria inventar
 * tiempo detenido a partir de la falta de datos.
 */
function detectarDetenciones(
  confiables: readonly PuntoTraza[],
  parametros: ParametrosTraza,
): readonly DetencionTraza[] {
  const detenciones: DetencionTraza[] = [];
  if (confiables.length < 2) return detenciones;

  let anclaIdx = 0;
  for (let i = 1; i <= confiables.length; i += 1) {
    const previo = confiables[i - 1]!;
    const siguiente = i < confiables.length ? confiables[i]! : null;
    const ancla = confiables[anclaIdx]!;

    const rompe =
      siguiente === null ||
      esSalto(previo, siguiente, parametros) ||
      haversineM(ancla.latitude, ancla.longitude, siguiente.latitude, siguiente.longitude) >
        parametros.stopRadiusM;
    if (!rompe) continue;

    const segundos = (previo.instante.getTime() - ancla.instante.getTime()) / 1000;
    const cuantos = i - anclaIdx;
    if (cuantos >= 2 && segundos >= parametros.stopMinSeconds) {
      detenciones.push({
        fromAt: ancla.instante,
        toAt: previo.instante,
        minutes: redondear(segundos / 60),
        latitude: ancla.latitude,
        longitude: ancla.longitude,
        points: cuantos,
      });
    }
    // La ventana siguiente arranca en el punto que rompio la actual.
    anclaIdx = i;
  }
  return detenciones;
}

/** ¿Entre estos dos puntos utilizables hay un hueco de cobertura? */
function esSalto(a: PuntoTraza, b: PuntoTraza, parametros: ParametrosTraza): boolean {
  return (b.instante.getTime() - a.instante.getTime()) / 1000 > parametros.gapMinSeconds;
}

/**
 * Ultima bateria conocida antes de un instante, o primera despues.
 *
 * Se mira sobre TODOS los puntos, tambien los imprecisos: un fix malo igual
 * informa el nivel de bateria, y para explicar el hueco eso es lo que importa.
 */
function bateriaEn(
  puntos: readonly PuntoTraza[],
  instante: Date,
  lado: 'antes' | 'despues',
): number | null {
  const limite = instante.getTime();
  if (lado === 'antes') {
    for (let i = puntos.length - 1; i >= 0; i -= 1) {
      const punto = puntos[i]!;
      if (punto.instante.getTime() <= limite && punto.batteryPct !== null) return punto.batteryPct;
    }
    return null;
  }
  for (const punto of puntos) {
    if (punto.instante.getTime() >= limite && punto.batteryPct !== null) return punto.batteryPct;
  }
  return null;
}

function menor(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function mayor(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** El driver entrega numeric como string y smallint como number. */
function aNumero(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const numero = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function aFecha(valor: Date | string | null | undefined): Date | null {
  if (!valor) return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Un decimal: la traza tiene precision de metros y de minutos, no de laboratorio. */
function redondear(valor: number): number {
  return Math.round(valor * 10) / 10;
}
