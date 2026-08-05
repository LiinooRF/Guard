/**
 * Pruebas de la matemática de tiles del precache offline (#76).
 *
 * Se prueba contra valores conocidos del esquema "slippy map" de OSM, el filtro
 * de recuadro y el tope de tiles: bajar los tiles equivocados deja al guardia sin
 * mapa justo cuando no tiene señal.
 */

import {
  MAX_TILES,
  latATileY,
  lonATileX,
  recuadroDePuntos,
  tilesDelRecuadro,
  urlDeTile,
} from './guard-tiles-modelo';

describe('conversión lon/lat a tile', () => {
  it('coincide con los valores conocidos de OSM (Santiago, z=16)', () => {
    // Tile estándar "slippy map" para -33.45, -70.66 en zoom 16.
    expect(lonATileX(-70.66, 16)).toBe(19904);
    expect(latATileY(-33.45, 16)).toBe(39236);
  });

  it('en z=0 todo el mundo es el tile 0/0', () => {
    expect(lonATileX(-70, 0)).toBe(0);
    expect(latATileY(-33, 0)).toBe(0);
  });
});

describe('recuadroDePuntos', () => {
  it('envuelve todos los puntos y agrega margen', () => {
    const r = recuadroDePuntos([
      { lat: -33.45, lng: -70.66 },
      { lat: -33.46, lng: -70.65 },
    ], 0.01);
    expect(r).not.toBeNull();
    expect(r!.minLat).toBeCloseTo(-33.47);
    expect(r!.maxLat).toBeCloseTo(-33.44);
    expect(r!.minLng).toBeCloseTo(-70.67);
    expect(r!.maxLng).toBeCloseTo(-70.64);
  });

  it('sin puntos no hay recuadro', () => {
    expect(recuadroDePuntos([])).toBeNull();
  });
});

describe('tilesDelRecuadro', () => {
  it('devuelve al menos un tile por nivel para un recinto chico', () => {
    const r = recuadroDePuntos([{ lat: -33.45, lng: -70.66 }], 0.001)!;
    const tiles = tilesDelRecuadro(r, [16, 17]);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles.some((t) => t.z === 16)).toBe(true);
    expect(tiles.some((t) => t.z === 17)).toBe(true);
  });

  it('nunca supera el tope MAX_TILES', () => {
    const grande = { minLat: -34, minLng: -71, maxLat: -33, maxLng: -70 };
    const tiles = tilesDelRecuadro(grande, [18]);
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES);
  });
});

describe('urlDeTile', () => {
  it('reemplaza z, x, y y el subdominio', () => {
    expect(
      urlDeTile('https://{s}.tiles.cl/{z}/{x}/{y}.png', { z: 16, x: 21899, y: 39901 }, 'b'),
    ).toBe('https://b.tiles.cl/16/21899/39901.png');
  });

  it('funciona sin subdominio en la plantilla', () => {
    expect(urlDeTile('https://tiles.cl/{z}/{x}/{y}.png', { z: 1, x: 2, y: 3 })).toBe(
      'https://tiles.cl/1/2/3.png',
    );
  });
});
