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

import { esCoordenadaValida, type PuntoMapa, type TrazaMapa } from './mapa-modelo';

export interface PuntoTrack {
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  batteryPct: number | null;
}

export interface CheckpointTrack {
  id: string;
  name: string;
  position: number;
  latitude: number | null;
  longitude: number | null;
  scanned?: boolean;
  isCritical?: boolean;
}

export interface RespuestaTrack {
  patrolId: string;
  points: PuntoTrack[];
  checkpoints?: CheckpointTrack[];
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

/**
 * Marcas de los puntos de control de la ronda para superponer sobre el mapa.
 */
export function marcasDeCheckpoints(checkpoints: readonly CheckpointTrack[]): PuntoMapa[] {
  const marcas: PuntoMapa[] = [];
  const ordenados = [...checkpoints].sort((a, b) => a.position - b.position);
  for (const c of ordenados) {
    if (!esCoordenadaValida(c.latitude, c.longitude)) continue;
    marcas.push({
      id: c.id,
      lat: c.latitude as number,
      lng: c.longitude as number,
      titulo: c.name,
      numero: c.position,
      detalle: c.scanned ? 'Cumplido' : 'Pendiente',
      variante: c.scanned ? 'fin' : c.isCritical ? 'alerta' : 'punto',
    });
  }
  return marcas;
}

/**
 * Traza de la ronda patrón: línea que conecta los checkpoints de la ruta en su
 * orden planificado (variante 'ruta' -> punteada).
 */
export function trazaDePatronCheckpoints(checkpoints: readonly CheckpointTrack[]): TrazaMapa | null {
  const ordenados = [...checkpoints].sort((a, b) => a.position - b.position);
  const validos = ordenados.filter((c) => esCoordenadaValida(c.latitude, c.longitude));
  if (validos.length < 2) return null;
  return {
    id: 'ruta-patron',
    variante: 'ruta',
    puntos: validos.map((c) => ({
      lat: c.latitude as number,
      lng: c.longitude as number,
    })),
  };
}

/** Cuántos puntos del track sirven para dibujar (coordenada válida). */
export function puntosDibujables(puntos: readonly PuntoTrack[]): number {
  return puntos.filter((p) => esCoordenadaValida(p.latitude, p.longitude)).length;
}

export interface ResumenCheckpointsRonda {
  total: number;
  conUbicacion: number;
  sinUbicacion: number;
  cumplidos: number;
  pendientes: number;
}

/**
 * Resumen de los puntos de control de la ronda para mostrar cuántos tienen GPS
 * y cuántos son interiores/subterráneos.
 */
export function resumenDeCheckpoints(
  checkpoints: readonly CheckpointTrack[],
): ResumenCheckpointsRonda {
  const total = checkpoints.length;
  let conUbicacion = 0;
  let cumplidos = 0;
  for (const c of checkpoints) {
    if (esCoordenadaValida(c.latitude, c.longitude)) conUbicacion += 1;
    if (c.scanned) cumplidos += 1;
  }
  return {
    total,
    conUbicacion,
    sinUbicacion: total - conUbicacion,
    cumplidos,
    pendientes: total - cumplidos,
  };
}

