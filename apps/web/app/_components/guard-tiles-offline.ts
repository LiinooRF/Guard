'use client';

/**
 * Precarga de tiles para uso offline (#76).
 *
 * Cuando la ronda carga con señal, se calculan los tiles del recinto y se le
 * piden al Service Worker (`/sw-tiles.js`) que los guarde. Así, en modo avión,
 * el mapa se dibuja desde el cache en vez de quedar en blanco.
 *
 * Todo es best-effort y degrada en silencio: sin Service Worker, sin proveedor
 * de tiles o sin señal, no se precachea nada y el mapa sigue funcionando online
 * y el modo lista queda de respaldo. Nunca rompe la ronda.
 */

import { resolverOrigenTiles } from './mapa-tiles';
import { recuadroDePuntos, tilesDelRecuadro, urlDeTile } from './guard-tiles-modelo';

/** Niveles que se bajan: suficientes para ubicarse dentro de un recinto. */
const ZOOMS_OFFLINE = [15, 16, 17];

/** La misma resolución de proveedor que usa `MapaBase`, para bajar los mismos tiles. */
function plantillaDeTiles(): string | null {
  return resolverOrigenTiles({
    url: process.env.NEXT_PUBLIC_MAP_TILES_URL,
    atribucion: process.env.NEXT_PUBLIC_MAP_TILES_ATTRIBUTION,
    maxZoom: process.env.NEXT_PUBLIC_MAP_TILES_MAX_ZOOM,
    produccion: process.env.NODE_ENV === 'production',
  }).url;
}

export async function precacheTilesDeRuta(
  puntos: ReadonlyArray<{ lat: number; lng: number }>,
): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (navigator.onLine === false) return; // Sin señal no hay nada que bajar.

  const plantilla = plantillaDeTiles();
  if (!plantilla) return;

  const recuadro = recuadroDePuntos(puntos);
  if (!recuadro) return;

  const urls = tilesDelRecuadro(recuadro, ZOOMS_OFFLINE).map((tile) => urlDeTile(plantilla, tile));
  if (urls.length === 0) return;

  try {
    await navigator.serviceWorker.register('/sw-tiles.js');
    const registro = await navigator.serviceWorker.ready;
    registro.active?.postMessage({ type: 'precache-tiles', urls });
  } catch {
    // Sin SW no hay tiles offline; el mapa online y el modo lista siguen.
  }
}
