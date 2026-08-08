import { haversineM } from '../geo/haversine';

/**
 * Las dos anomalias de SECUENCIA del catalogo (#60): las que no se pueden ver
 * mirando un escaneo solo, porque viven en la relacion entre un escaneo y los
 * anteriores de la misma ronda.
 *
 * Estaban declaradas en `scanAnomalySchema`, el informe las dibujaba, el portal
 * tenia su etiqueta, la bandeja de alertas disparaba al acumularlas... y ningun
 * codigo las escribia. El propio issue lo dice: sin esta deteccion el sistema
 * da una falsa sensacion de control, que es peor que no tener sistema.
 *
 * Las dos MARCAN, no rechazan (regla de CLAUDE.md): descartar automaticamente
 * castigaria al guardia por condiciones normales de trabajo. La decision es del
 * supervisor con la marca a la vista.
 */

/** Un escaneo reducido a lo que estas señales necesitan. */
export interface EscaneoParaSecuencia {
  /** Coordenadas FIJAS del punto de control; null si el punto no las tiene. */
  latitude: number | null;
  longitude: number | null;
  /** Hora del SERVIDOR del escaneo. Nunca la del telefono: se puede mentir. */
  at: Date;
}

/**
 * El guardia que se lleva las etiquetas a la caseta y las escanea todas juntas.
 *
 * La velocidad se mide entre las coordenadas de los PUNTOS, no entre los GPS
 * del telefono, y esa eleccion es la mitad del diseño: las etiquetas estan
 * pegadas a algo que no se mueve, asi que la distancia es exacta y un GPS
 * impreciso en un subterraneo no puede ni fabricar la anomalia ni taparla. La
 * otra mitad es el reloj: hora del servidor en los dos extremos, porque la del
 * dispositivo la controla quien comete el fraude.
 *
 * Casos que NO se pueden medir, y devuelven false a proposito:
 * - un punto sin coordenadas (el panel ya avisa cuales son);
 * - el primer escaneo de la ronda (no hay contra que comparar — eso lo decide
 *   quien llama, aca simplemente no llega).
 *
 * El tiempo se pisa a un minimo de un segundo: dos escaneos en el mismo
 * instante a un kilometro de distancia son la version mas descarada del fraude
 * y una division por cero no es un veredicto.
 */
export function velocidadImposible(
  previo: EscaneoParaSecuencia,
  actual: EscaneoParaSecuencia,
  maxKmh: number,
): boolean {
  if (previo.latitude === null || previo.longitude === null) return false;
  if (actual.latitude === null || actual.longitude === null) return false;

  const metros = haversineM(previo.latitude, previo.longitude, actual.latitude, actual.longitude);
  const segundos = Math.max((actual.at.getTime() - previo.at.getTime()) / 1000, 1);
  const kmh = (metros / segundos) * 3.6;
  return kmh > maxKmh;
}

/**
 * El otro fraude que el issue nombra: "le presto el telefono a un compañero".
 *
 * Si la ronda ya recibio escaneos firmados por un dispositivo y llega uno de
 * OTRO, el nuevo queda marcado. No distingue quien es el legitimo — no puede,
 * y no le toca: el supervisor ve la marca y pregunta.
 *
 * Un escaneo sin dispositivo (camino legacy) no participa: ya lleva su propia
 * marca (`firma_dispositivo_ausente`) y sumarle esta seria contarle la misma
 * falta dos veces.
 */
export function dispositivoDuplicado(
  dispositivosPrevios: ReadonlyArray<string | null>,
  dispositivoActual: string | null,
): boolean {
  if (!dispositivoActual) return false;
  const conocidos = new Set(dispositivosPrevios.filter((d): d is string => d !== null && d !== ''));
  return conocidos.size > 0 && !conocidos.has(dispositivoActual);
}
