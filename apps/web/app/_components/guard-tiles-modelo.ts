/**
 * Matemática de tiles para la descarga previa offline (#76).
 *
 * Para que el guardia siga viendo el mapa en modo avión hay que bajar los tiles
 * del recinto ANTES, con señal. Esto calcula QUÉ tiles cubren la ronda: de las
 * coordenadas de los puntos sale un recuadro, y de ahí los tiles (z/x/y) de cada
 * nivel de zoom.
 *
 * Es lógica pura y sin red, para poder probarla: la conversión lon/lat→tile es
 * el estándar de "slippy map" (el mismo que usa Leaflet), y equivocarla baja los
 * tiles de otro lado del mundo.
 */

export interface Recuadro {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface Tile {
  z: number;
  x: number;
  y: number;
}

/** Tope de tiles a bajar de una vez: un recinto es chico y no queremos vaciar la cuota. */
export const MAX_TILES = 240;

export function lonATileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latATileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

/** Recuadro que envuelve todos los puntos, con un pequeño margen para no cortar justo en el borde. */
export function recuadroDePuntos(
  puntos: ReadonlyArray<{ lat: number; lng: number }>,
  margen = 0.002,
): Recuadro | null {
  if (puntos.length === 0) return null;
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const { lat, lng } of puntos) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  return {
    minLat: minLat - margen,
    minLng: minLng - margen,
    maxLat: maxLat + margen,
    maxLng: maxLng + margen,
  };
}

/**
 * Tiles que cubren el recuadro en los niveles de zoom pedidos. Se detiene al
 * llegar a `MAX_TILES`: más que eso no es "el recinto", es medio mapa, y no cabe
 * la intención de un precache acotado.
 */
export function tilesDelRecuadro(recuadro: Recuadro, zooms: readonly number[]): Tile[] {
  const tiles: Tile[] = [];
  for (const z of zooms) {
    const xMin = lonATileX(recuadro.minLng, z);
    const xMax = lonATileX(recuadro.maxLng, z);
    // La latitud crece hacia el norte pero la Y del tile crece hacia el sur:
    // por eso el mínimo de Y sale del máximo de latitud.
    const yMin = latATileY(recuadro.maxLat, z);
    const yMax = latATileY(recuadro.minLat, z);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        tiles.push({ z, x, y });
        if (tiles.length >= MAX_TILES) return tiles;
      }
    }
  }
  return tiles;
}

/** Arma la URL del tile desde la plantilla `{z}/{x}/{y}` (y `{s}` si la hubiera). */
export function urlDeTile(plantilla: string, tile: Tile, subdominio = 'a'): string {
  return plantilla
    .replace('{s}', subdominio)
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}
