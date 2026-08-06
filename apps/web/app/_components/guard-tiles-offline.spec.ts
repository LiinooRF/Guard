/**
 * Pruebas de la precarga de tiles offline (#76), desde el angulo del volumen (#75).
 *
 * El criterio de aceptacion de #75 dice "el origen de tiles aguanta el volumen
 * esperado sin ser bloqueado", y el mayor consumidor de tiles del producto no es
 * el supervisor mirando el panel: es esta precarga, que baja hasta 240 imagenes
 * por ronda.
 *
 * El caso que se prueba es el que la hacia peligrosa: `GuardMapa` dispara la
 * precarga desde un efecto que depende de las marcas de la ruta, y esas se
 * recalculan en CADA escaneo porque cambia el color del punto cumplido. Lo que
 * NO cambia son las coordenadas — y por lo tanto los tiles. Aca se prueba con el
 * mismo `marcasDeRuta` que usa la pantalla, no con datos inventados a mano.
 */

import { marcasDeRuta } from './guard-mapa-modelo';
import type { PuntoRuta } from './guard-shift-state';
import { MAX_TILES } from './guard-tiles-modelo';
import { firmaDePrecache, urlsDeTilesDeRuta } from './guard-tiles-offline';

const PLANTILLA = 'https://tiles.midominio.cl/{z}/{x}/{y}.png';

/** Una ronda chica en un recinto de Santiago, del tamano que se ve en terreno. */
const RUTA: PuntoRuta[] = [
  { id: 'p1', name: 'Porton norte', position: 1, latitude: -33.4372, longitude: -70.6506 },
  { id: 'p2', name: 'Bodega', position: 2, latitude: -33.4381, longitude: -70.6492 },
  { id: 'p3', name: 'Estacionamiento -2', position: 3, latitude: -33.4368, longitude: -70.6488 },
  { id: 'p4', name: 'Sala electrica', position: 4, latitude: -33.4375, longitude: -70.6515 },
];

describe('urlsDeTilesDeRuta', () => {
  it('arma las URLs con la plantilla configurada', () => {
    const urls = urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1'));

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://tiles.midominio.cl/')).toBe(true);
      // Ninguna marca sin reemplazar: un `{z}` que sobrevive es un 404 por tile.
      expect(url).not.toContain('{');
    }
  });

  it('sirve igual con una ruta del mismo origen', () => {
    const urls = urlsDeTilesDeRuta('/tiles/{z}/{x}/{y}.png', marcasDeRuta(RUTA, new Set(), 'p1'));

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('/tiles/'))).toBe(true);
  });

  it('sin plantilla no pide nada, en vez de inventar una', () => {
    expect(urlsDeTilesDeRuta(null, marcasDeRuta(RUTA, new Set(), 'p1'))).toEqual([]);
  });

  it('una ruta sin coordenadas no genera descargas', () => {
    const sinUbicar: PuntoRuta[] = [
      { id: 'p1', name: 'Porton', position: 1 },
      { id: 'p2', name: 'Bodega', position: 2, latitude: null, longitude: null },
    ];

    expect(urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(sinUbicar, new Set(), 'p1'))).toEqual([]);
  });

  it('respeta el tope de tiles del recinto', () => {
    const urls = urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1'));

    expect(urls.length).toBeLessThanOrEqual(MAX_TILES);
  });
});

/*
 * El nucleo: avanzar la ronda no genera ni una descarga mas.
 */
describe('la precarga no se repite al avanzar la ronda', () => {
  it('los tiles son los mismos con la ronda recien empezada y con la ronda entera escaneada', () => {
    const alEmpezar = urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1'));
    const aMitad = urlsDeTilesDeRuta(
      PLANTILLA,
      marcasDeRuta(RUTA, new Set(['p1', 'p2']), 'p3'),
    );
    const alTerminar = urlsDeTilesDeRuta(
      PLANTILLA,
      marcasDeRuta(RUTA, new Set(['p1', 'p2', 'p3', 'p4']), undefined),
    );

    expect(aMitad).toEqual(alEmpezar);
    expect(alTerminar).toEqual(alEmpezar);
  });

  it('y por lo tanto la firma no cambia, que es lo que corta la repeticion', () => {
    const firmaInicial = firmaDePrecache(
      urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1')),
    );

    // Un escaneo tras otro, como en una ronda de verdad.
    const escaneados = new Set<string>();
    for (const punto of RUTA) {
      escaneados.add(punto.id);
      const firma = firmaDePrecache(
        urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, escaneados, undefined)),
      );
      expect(firma).toBe(firmaInicial);
    }
  });

  it('un recinto distinto si tiene otra firma: no se confunde con el anterior', () => {
    const otroRecinto: PuntoRuta[] = [
      { id: 'q1', name: 'Acceso', position: 1, latitude: -36.8201, longitude: -73.0444 },
      { id: 'q2', name: 'Patio', position: 2, latitude: -36.8215, longitude: -73.0431 },
    ];

    const firmaSantiago = firmaDePrecache(
      urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1')),
    );
    const firmaConcepcion = firmaDePrecache(
      urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(otroRecinto, new Set(), 'q1')),
    );

    expect(firmaConcepcion).not.toBe(firmaSantiago);
  });

  it('cambiar de proveedor tambien cambia la firma: hay que bajar el cache nuevo', () => {
    const conProveedor = firmaDePrecache(
      urlsDeTilesDeRuta(PLANTILLA, marcasDeRuta(RUTA, new Set(), 'p1')),
    );
    const conProxy = firmaDePrecache(
      urlsDeTilesDeRuta('/tiles/{z}/{x}/{y}.png', marcasDeRuta(RUTA, new Set(), 'p1')),
    );

    expect(conProxy).not.toBe(conProveedor);
  });

  it('sin tiles, la firma es vacia y no bloquea un intento posterior', () => {
    expect(firmaDePrecache([])).toBe('');
  });
});
