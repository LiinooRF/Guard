/**
 * Modelo de la traza del recorrido (#134): convierte los puntos GPS que devuelve
 * `GET /geo/patrols/:id/track` en la línea que dibuja `MapaBase`.
 *
 * Lógica pura, sin React ni Leaflet, para poder probarla: filtrar coordenadas
 * inválidas y decidir cuándo hay recorrido que mostrar es una regla, no dibujo.
 *
 * La traza es lo que #134 agrega **además** de los puntos escaneados: el camino
 * real entre punto y punto, no solo dónde se tocó una etiqueta.
 */

import { esCoordenadaValida, type TrazaMapa } from './mapa-modelo';

export interface PuntoTrack {
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  batteryPct: number | null;
}

export interface RespuestaTrack {
  patrolId: string;
  points: PuntoTrack[];
  totalDistanceM?: number;
  durationMin?: number;
}

/**
 * Traza del recorrido, o `null` si no hay línea que dibujar. Se necesita más de
 * un punto válido: un solo punto no es un recorrido, es una posición, y dibujar
 * una línea de un vértice deja una mancha que se lee mal.
 */
export function trazaDeRecorrido(puntos: readonly PuntoTrack[]): TrazaMapa | null {
  const validos = puntos.filter((p) => esCoordenadaValida(p.latitude, p.longitude));
  if (validos.length < 2) return null;
  return {
    id: 'recorrido',
    variante: 'recorrido',
    puntos: validos.map((p) => ({ lat: p.latitude, lng: p.longitude })),
  };
}

/** Cuántos puntos del track sirven para dibujar (coordenada válida). */
export function puntosDibujables(puntos: readonly PuntoTrack[]): number {
  return puntos.filter((p) => esCoordenadaValida(p.latitude, p.longitude)).length;
}
