/**
 * Pruebas del modelo del visor de ruta (#76): el estado de cada punto, el filtro
 * de coordenadas y la leyenda que se arma con lo que de verdad aparece.
 */

import { estadoDelPunto, leyendaDeRuta, marcasDeRuta, trazaDeRutaPatron } from './guard-mapa-modelo';
import type { PuntoRuta } from './guard-shift-state';

const punto = (id: string, position: number, coords?: [number, number]): PuntoRuta => ({
  id,
  name: `Punto ${id}`,
  position,
  ...(coords ? { latitude: coords[0], longitude: coords[1] } : {}),
});

const RUTA: PuntoRuta[] = [
  punto('a', 1, [-33.45, -70.66]),
  punto('b', 2, [-33.451, -70.661]),
  punto('c', 3, [-33.452, -70.662]),
];

describe('estadoDelPunto', () => {
  it('escaneado = cumplido, el siguiente = siguiente, el resto = pendiente', () => {
    const escaneados = new Set(['a']);
    expect(estadoDelPunto(RUTA[0]!, escaneados, 'b')).toBe('cumplido');
    expect(estadoDelPunto(RUTA[1]!, escaneados, 'b')).toBe('siguiente');
    expect(estadoDelPunto(RUTA[2]!, escaneados, 'b')).toBe('pendiente');
  });
});

describe('marcasDeRuta', () => {
  it('devuelve una marca por punto con coordenadas, ordenadas por posición', () => {
    const marcas = marcasDeRuta(RUTA, new Set(['a']), 'b');
    expect(marcas.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(marcas[0]).toMatchObject({ variante: 'fin', numero: 1, titulo: 'Punto a' });
    expect(marcas[1]).toMatchObject({ variante: 'inicio', detalle: 'Siguiente punto' });
    expect(marcas[2]?.variante).toBe('punto');
  });

  it('omite los puntos sin coordenadas y los (0,0)', () => {
    const marcas = marcasDeRuta(
      [punto('a', 1, [-33.45, -70.66]), punto('sin', 2), punto('cero', 3, [0, 0])],
      new Set(),
      'a',
    );
    expect(marcas.map((m) => m.id)).toEqual(['a']);
  });
});

describe('trazaDeRutaPatron', () => {
  it('crea una traza de variante "ruta" conectando los puntos en orden de posición', () => {
    const traza = trazaDeRutaPatron(RUTA);
    expect(traza).not.toBeNull();
    expect(traza!.id).toBe('ruta-patron');
    expect(traza!.variante).toBe('ruta');
    expect(traza!.puntos).toEqual([
      { lat: -33.45, lng: -70.66 },
      { lat: -33.451, lng: -70.661 },
      { lat: -33.452, lng: -70.662 },
    ]);
  });

  it('ordena por position independientemente del orden en el arreglo', () => {
    const desordenados: PuntoRuta[] = [
      punto('c', 3, [-33.452, -70.662]),
      punto('a', 1, [-33.45, -70.66]),
      punto('b', 2, [-33.451, -70.661]),
    ];
    const traza = trazaDeRutaPatron(desordenados);
    expect(traza!.puntos).toEqual([
      { lat: -33.45, lng: -70.66 },
      { lat: -33.451, lng: -70.661 },
      { lat: -33.452, lng: -70.662 },
    ]);
  });

  it('devuelve null si hay menos de dos puntos con coordenadas válidas', () => {
    expect(trazaDeRutaPatron([punto('a', 1, [-33.45, -70.66])])).toBeNull();
    expect(trazaDeRutaPatron([punto('a', 1, [-33.45, -70.66]), punto('b', 2)])).toBeNull();
    expect(trazaDeRutaPatron([])).toBeNull();
  });
});

describe('leyendaDeRuta', () => {
  it('solo incluye los estados presentes en el mapa', () => {
    const leyenda = leyendaDeRuta(RUTA, new Set(['a']), 'b');
    expect(leyenda.map((i) => i.etiqueta)).toEqual(['Siguiente punto', 'Pendiente', 'Cumplido']);
  });

  it('con todo pendiente, la leyenda no muestra "Cumplido" ni "Siguiente"', () => {
    const leyenda = leyendaDeRuta(RUTA, new Set(), undefined);
    expect(leyenda.map((i) => i.etiqueta)).toEqual(['Pendiente']);
  });
});
