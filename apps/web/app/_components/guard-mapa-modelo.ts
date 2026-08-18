/**
 * Modelo del visor de ruta del guardia (#76): convierte los puntos de la ronda y
 * su estado (cumplido / siguiente / pendiente) en las marcas que dibuja
 * `MapaBase`.
 *
 * Es lógica pura, sin React ni Leaflet, para poder probarla: qué color le toca a
 * cada punto y qué leyenda mostrar es una regla del producto, no del mapa.
 *
 * Un punto sin coordenadas válidas se omite del mapa —la lista de puntos sigue
 * mostrándolo—; sin este filtro un `null` mal convertido caería en (0,0), en
 * medio del Atlántico.
 */

import { esCoordenadaValida, type PuntoMapa, type TrazaMapa } from './mapa-modelo';
import type { ItemLeyenda } from './mapa-leyenda';
import type { VarianteMarca } from './mapa-modelo';
import type { PuntoRuta } from './guard-shift-state';

export type EstadoPuntoRuta = 'cumplido' | 'siguiente' | 'pendiente';

/**
 * Qué variante de color usa cada estado. Se apoya en las variantes que ya define
 * `mapa-colores`; la leyenda de abajo les pone el nombre correcto para esta
 * pantalla (la misma variante significa otra cosa en el mapa de recintos).
 */
const VARIANTE_POR_ESTADO: Record<EstadoPuntoRuta, VarianteMarca> = {
  siguiente: 'inicio', // verde: "vas aquí ahora"
  cumplido: 'fin', // morado: ya escaneado
  pendiente: 'punto', // azul: todavía por hacer
};

const ETIQUETA_POR_ESTADO: Record<EstadoPuntoRuta, string> = {
  siguiente: 'Siguiente punto',
  cumplido: 'Cumplido',
  pendiente: 'Pendiente',
};

/** El orden en que se listan las claves en la leyenda. */
const ORDEN_ESTADOS: readonly EstadoPuntoRuta[] = ['siguiente', 'pendiente', 'cumplido'];

export function estadoDelPunto(
  punto: PuntoRuta,
  escaneados: ReadonlySet<string>,
  siguienteId: string | undefined,
): EstadoPuntoRuta {
  if (escaneados.has(punto.id)) return 'cumplido';
  if (punto.id === siguienteId) return 'siguiente';
  return 'pendiente';
}

/**
 * Marcas del mapa para la ruta, en orden de posición. Solo los puntos con
 * coordenadas válidas; el resto queda fuera del mapa pero sigue en la lista.
 */
export function marcasDeRuta(
  puntos: readonly PuntoRuta[],
  escaneados: ReadonlySet<string>,
  siguienteId: string | undefined,
): PuntoMapa[] {
  const marcas: PuntoMapa[] = [];
  for (const punto of [...puntos].sort((a, b) => a.position - b.position)) {
    if (!esCoordenadaValida(punto.latitude, punto.longitude)) continue;
    const estado = estadoDelPunto(punto, escaneados, siguienteId);
    marcas.push({
      id: punto.id,
      lat: punto.latitude as number,
      lng: punto.longitude as number,
      titulo: punto.name,
      numero: punto.position,
      detalle: ETIQUETA_POR_ESTADO[estado],
      variante: VARIANTE_POR_ESTADO[estado],
    });
  }
  return marcas;
}

/**
 * Traza de la ronda patrón: línea que conecta los puntos en el orden planificado
 * (variante 'ruta' -> punteada en MapaBase).
 *
 * Requiere al menos dos puntos con coordenadas válidas para formar un recorrido.
 */
export function trazaDeRutaPatron(puntos: readonly PuntoRuta[]): TrazaMapa | null {
  const ordenados = [...puntos].sort((a, b) => a.position - b.position);
  const validos = ordenados.filter((p) => esCoordenadaValida(p.latitude, p.longitude));
  if (validos.length < 2) return null;
  return {
    id: 'ruta-patron',
    variante: 'ruta',
    puntos: validos.map((p) => ({
      lat: p.latitude as number,
      lng: p.longitude as number,
    })),
  };
}

/** Leyenda con solo los estados que de verdad aparecen en el mapa. */
export function leyendaDeRuta(
  puntos: readonly PuntoRuta[],
  escaneados: ReadonlySet<string>,
  siguienteId: string | undefined,
): ItemLeyenda[] {
  const presentes = new Set<EstadoPuntoRuta>();
  for (const punto of puntos) {
    if (!esCoordenadaValida(punto.latitude, punto.longitude)) continue;
    presentes.add(estadoDelPunto(punto, escaneados, siguienteId));
  }
  return ORDEN_ESTADOS.filter((estado) => presentes.has(estado)).map((estado) => ({
    clave: VARIANTE_POR_ESTADO[estado],
    etiqueta: ETIQUETA_POR_ESTADO[estado],
  }));
}
