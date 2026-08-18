/**
 * Que se dibuja en el mapa, resuelto antes de tocar Leaflet (#75).
 *
 * Todo lo que se puede equivocar sin abrir un navegador vive aca: descartar las
 * coordenadas que no sirven, decidir si una traza alcanza a ser una linea y
 * calcular que hay que encuadrar. Es logica pura y se prueba con jest, igual que
 * `stats-charts-data.ts`.
 *
 * El componente `mapa-base.tsx` solo traduce este modelo a capas de Leaflet.
 */

import type { GeoPoint } from '@sentrycore/shared';

/** Que representa la marca. Cambia el color, no el comportamiento. */
export type VarianteMarca = 'punto' | 'recinto' | 'inicio' | 'fin' | 'alerta';

export interface PuntoMapa extends GeoPoint {
  id: string;
  /** Nombre visible. Viaja como texto: nunca se interpreta como HTML. */
  titulo: string;
  /** Segunda linea del globo, YA formateada por quien llama. */
  detalle?: string;
  variante?: VarianteMarca;
  /** Orden dentro de la ruta. Se dibuja adentro de la marca. */
  numero?: number;
}

export type VarianteTraza = 'recorrido' | 'ruta';

export interface TrazaMapa {
  id: string;
  puntos: ReadonlyArray<GeoPoint>;
  /** `recorrido` = por donde paso el guardia. `ruta` = el orden planificado. */
  variante?: VarianteTraza;
}

/** Par [lat, lng], que es como Leaflet recibe las coordenadas. */
export type ParLatLng = [number, number];

export interface LineaMapa {
  id: string;
  variante: VarianteTraza;
  coordenadas: ParLatLng[];
}

export interface ModeloMapa {
  /** Marcas con coordenada utilizable, en el orden en que llegaron. */
  marcas: PuntoMapa[];
  lineas: LineaMapa[];
  /** Todo lo que tiene que caber en la pantalla. */
  encuadre: ParLatLng[];
  /** Donde centrar cuando no hay nada que encuadrar. */
  centro: ParLatLng | null;
  /** `true` = no hay nada que dibujar y ni siquiera se crea el mapa. */
  vacio: boolean;
}

/**
 * Un recinto o un punto de control pueden no tener coordenada cargada: en la API
 * `latitude`/`longitude` son opcionales. Sin este filtro, un `null` convertido a
 * numero da 0 y el punto aparece en el Golfo de Guinea, que en el informe de una
 * ronda en Santiago es peor que un punto menos.
 */
export function esCoordenadaValida(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  // (0,0) es lo que deja un campo vacio mal convertido, no un recinto.
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * La traza que devuelve `GET /api/geo/patrols/:patrolId/track` viene con
 * `latitude`/`longitude`, y el dominio compartido usa `GeoPoint` (`lat`/`lng`).
 * Aca se traduce una sola vez, para que no se repita en cada pantalla que dibuje
 * un recorrido.
 */
export function puntosDeTraza(
  puntos: ReadonlyArray<{ latitude: number | string | null; longitude: number | string | null }>,
): GeoPoint[] {
  const resultado: GeoPoint[] = [];
  for (const punto of puntos) {
    const lat = Number(punto.latitude);
    const lng = Number(punto.longitude);
    if (!esCoordenadaValida(lat, lng)) continue;
    resultado.push({ lat, lng });
  }
  return resultado;
}

/**
 * Arma el modelo de dibujo a partir de lo que entrego quien usa el componente.
 *
 * Dos criterios que valen la pena mirar:
 *
 * - Una traza con menos de dos puntos utilizables NO es una linea. Dibujar un
 *   segmento de un solo vertice deja una mancha que se lee como "recorrido", y
 *   una ronda con un solo punto de GPS es justamente lo contrario.
 * - El encuadre se arma con las marcas Y con las lineas. Encuadrar solo los
 *   puntos de control deja al guardia fuera de la pantalla cuando se desvio, que
 *   es exactamente lo que el supervisor esta mirando.
 */
export function construirModelo(
  puntos: ReadonlyArray<PuntoMapa>,
  trazas: ReadonlyArray<TrazaMapa>,
  centro: GeoPoint | null | undefined,
): ModeloMapa {
  const marcas: PuntoMapa[] = [];
  const lineas: LineaMapa[] = [];
  const encuadre: ParLatLng[] = [];

  for (const traza of trazas) {
    const coordenadas: ParLatLng[] = [];
    for (const punto of traza.puntos) {
      if (!esCoordenadaValida(punto.lat, punto.lng)) continue;
      coordenadas.push([punto.lat, punto.lng]);
    }
    if (coordenadas.length < 2) continue;
    lineas.push({ id: traza.id, variante: traza.variante ?? 'recorrido', coordenadas });
    encuadre.push(...coordenadas);
  }

  for (const punto of puntos) {
    if (!esCoordenadaValida(punto.lat, punto.lng)) continue;
    marcas.push(punto);
    encuadre.push([punto.lat, punto.lng]);
  }

  const centroUtil: ParLatLng | null =
    centro && esCoordenadaValida(centro.lat, centro.lng) ? [centro.lat, centro.lng] : null;

  return {
    marcas,
    lineas,
    encuadre,
    centro: centroUtil,
    vacio: encuadre.length === 0 && centroUtil === null,
  };
}

/**
 * Resumen del contenido, para saber cuando hay que redibujar.
 *
 * Las props llegan como arreglos NUEVOS en cada render, asi que compararlas por
 * identidad haria que el mapa se rearmara para siempre —y se re-encuadrara
 * mientras el usuario lo esta moviendo, que es la falla mas irritante de un
 * mapa—. Esta firma cambia solo cuando cambia lo que hay que dibujar.
 */
export function firmaDelContenido(
  puntos: ReadonlyArray<PuntoMapa>,
  trazas: ReadonlyArray<TrazaMapa>,
  centro: GeoPoint | null | undefined,
): string {
  return JSON.stringify([
    puntos.map((punto) => [
      punto.id,
      punto.lat,
      punto.lng,
      punto.variante ?? '',
      punto.titulo,
      punto.detalle ?? '',
      punto.numero ?? '',
    ]),
    trazas.map((traza) => [
      traza.id,
      traza.variante ?? '',
      traza.puntos.map((punto) => [punto.lat, punto.lng]),
    ]),
    centro ? [centro.lat, centro.lng] : null,
  ]);
}
