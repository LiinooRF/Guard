/**
 * Alta de puntos de control estando parado en el punto (#231).
 *
 * El supervisor da de alta el punto en terreno: escanea la etiqueta que acaba
 * de pegar y la coordenada queda tomada ahi mismo. Antes las dos cosas se
 * tecleaban desde un escritorio, y es la via por la que un punto termina sin
 * coordenada —o con la del recinto en vez de la suya— y despues el mapa del
 * informe no lo puede dibujar.
 *
 * Esto es logica pura a proposito: decide QUE coordenada vale y QUE se le dice
 * al supervisor. El componente solo pinta el resultado.
 */

export type Coordenadas = [number | null, number | null];

/** Lectura de etiqueta tal como la entrega el puente nativo. */
export interface EscaneoDePunto {
  readonly uid?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyM?: number;
}

export interface CapturaDePunto {
  readonly uid: string;
  /** `null` cuando la lectura no trajo posicion utilizable. */
  readonly coordenadas: Coordenadas | null;
  readonly aviso: string;
}

/**
 * Seis decimales son ~11 cm: mas cifras no son precision, son ruido del GPS
 * ocupando lugar en la base y en el informe.
 */
export function redondear(valor: number): number {
  return Math.round(valor * 1_000_000) / 1_000_000;
}

/** Una coordenada de verdad, no un 0/0 ni un NaN colado por el shell. */
function esCoordenadaUsable(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Precision alta = el punto puede quedar en la vereda de enfrente. Se DICE
 * siempre, porque el unico que puede decidir si camina unos pasos y vuelve a
 * medir es quien esta parado ahi.
 */
export function textoDePrecision(accuracyM: number | undefined): string {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return '';
  const metros = Math.round(accuracyM);
  if (metros > PRECISION_DUDOSA_M) {
    return ` Ojo: ${metros} m de precisión, camina unos pasos y vuelve a tomarla.`;
  }
  return ` Precisión ${metros} m.`;
}

/** Sobre este radio el punto puede caer en otra fachada. */
export const PRECISION_DUDOSA_M = 30;

/**
 * Traduce la lectura de la etiqueta a lo que queda en el formulario.
 *
 * Se usa la coordenada QUE VINO EN EL ESCANEO y no una lectura aparte del GPS:
 * entre escanear y pedir la ubicacion el supervisor camina, y la coordenada
 * deja de corresponder al punto. Por eso el contrato del puente las manda
 * juntas.
 */
export function capturaDeEscaneo(leido: EscaneoDePunto | null | undefined): CapturaDePunto {
  const uid = leido?.uid?.trim() ?? '';
  if (!uid) throw new Error('La lectura vino sin UID de etiqueta.');
  if (!esCoordenadaUsable(leido?.latitude, leido?.longitude)) {
    return {
      uid,
      coordenadas: null,
      aviso: `Etiqueta ${uid} leída. El escaneo no trajo ubicación: tómala con el botón de abajo.`,
    };
  }
  return {
    uid,
    coordenadas: [redondear(leido!.latitude!), redondear(leido!.longitude!)],
    aviso: `Etiqueta ${uid} leída, con la ubicación del escaneo.${textoDePrecision(leido?.accuracyM)}`,
  };
}

/** Lo mismo para el boton de solo-ubicacion, cuando el punto no lleva etiqueta. */
export function capturaDeUbicacion(coords: {
  latitude: number;
  longitude: number;
  accuracy?: number;
}): Omit<CapturaDePunto, 'uid'> {
  if (!esCoordenadaUsable(coords.latitude, coords.longitude)) {
    return { coordenadas: null, aviso: 'La ubicación que entregó el teléfono no es válida.' };
  }
  return {
    coordenadas: [redondear(coords.latitude), redondear(coords.longitude)],
    aviso: `Ubicación tomada.${textoDePrecision(coords.accuracy)}`,
  };
}
