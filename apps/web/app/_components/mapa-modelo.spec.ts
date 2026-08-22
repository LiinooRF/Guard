/**
 * Pruebas del modelo de dibujo del mapa (#75).
 *
 * Lo que se prueba es lo que se ve mal cuando falla: un recinto sin coordenada
 * que termina dibujado en medio del Atlantico, una traza de un solo punto que se
 * lee como recorrido, y un encuadre que deja al guardia fuera de pantalla justo
 * cuando el supervisor lo esta buscando.
 */

import {
  clasificarPrecisionGps,
  construirModelo,
  esCoordenadaValida,
  firmaDelContenido,
  formatearPrecisionGps,
  puntosDeTraza,
  type PuntoMapa,
  type TrazaMapa,
} from './mapa-modelo';

const PORTERIA: PuntoMapa = {
  id: 'p1',
  lat: -33.4489,
  lng: -70.6693,
  titulo: 'Portería',
  variante: 'punto',
  numero: 1,
};

const BODEGA: PuntoMapa = {
  id: 'p2',
  lat: -33.4495,
  lng: -70.6701,
  titulo: 'Bodega',
  variante: 'punto',
  numero: 2,
};

const SIN_COORDENADA = {
  id: 'p3',
  lat: 0,
  lng: 0,
  titulo: 'Punto sin ubicación cargada',
} satisfies PuntoMapa;

describe('esCoordenadaValida', () => {
  it('acepta una coordenada de Santiago', () => {
    expect(esCoordenadaValida(-33.4489, -70.6693)).toBe(true);
  });

  it('rechaza el recinto sin coordenada cargada', () => {
    expect(esCoordenadaValida(null, null)).toBe(false);
    expect(esCoordenadaValida(undefined, undefined)).toBe(false);
    expect(esCoordenadaValida('-33.4', '-70.6')).toBe(false);
  });

  it('rechaza el (0,0) que deja un campo vacio mal convertido', () => {
    expect(esCoordenadaValida(0, 0)).toBe(false);
  });

  it('rechaza valores fuera del rango geografico', () => {
    expect(esCoordenadaValida(91, 0)).toBe(false);
    expect(esCoordenadaValida(0, 181)).toBe(false);
    expect(esCoordenadaValida(Number.NaN, -70.6)).toBe(false);
  });
});

describe('clasificarPrecisionGps y formatearPrecisionGps', () => {
  it('identifica puntos sin coordenada', () => {
    expect(clasificarPrecisionGps(null, null, 10)).toBe('sin_coordenada');
    expect(clasificarPrecisionGps(0, 0, 10)).toBe('sin_coordenada');
  });

  it('clasifica precisión óptima vs estimada (subterránea)', () => {
    expect(clasificarPrecisionGps(-33.45, -70.66, 15)).toBe('optimo');
    expect(clasificarPrecisionGps(-33.45, -70.66, 85)).toBe('estimado');
  });

  it('formatea texto de precisión de manera clara', () => {
    expect(formatearPrecisionGps(null)).toBe('Precisión no informada');
    expect(formatearPrecisionGps(12.4)).toBe('±12 m');
    expect(formatearPrecisionGps(85.8)).toContain('señal estimada (subterráneo');
  });
});

describe('puntosDeTraza', () => {
  it('convierte los numeric que el driver entrega como texto', () => {
    expect(
      puntosDeTraza([
        { latitude: '-33.448900', longitude: '-70.669300' },
        { latitude: -33.449, longitude: -70.67 },
      ]),
    ).toEqual([
      { lat: -33.4489, lng: -70.6693 },
      { lat: -33.449, lng: -70.67 },
    ]);
  });

  it('descarta los puntos sin coordenada en vez de dibujarlos en el (0,0)', () => {
    expect(
      puntosDeTraza([
        { latitude: null, longitude: null },
        { latitude: '-33.4489', longitude: '-70.6693' },
        { latitude: 0, longitude: 0 },
      ]),
    ).toEqual([{ lat: -33.4489, lng: -70.6693 }]);
  });

  it('devuelve una lista vacia cuando la ronda todavia no tiene traza', () => {
    expect(puntosDeTraza([])).toEqual([]);
  });
});

describe('construirModelo', () => {
  it('deja las marcas con coordenada y descarta las que no la tienen', () => {
    const modelo = construirModelo([PORTERIA, SIN_COORDENADA, BODEGA], [], null);

    expect(modelo.marcas.map((marca) => marca.id)).toEqual(['p1', 'p2']);
    expect(modelo.encuadre).toHaveLength(2);
    expect(modelo.vacio).toBe(false);
  });

  it('no dibuja una linea con un solo punto utilizable', () => {
    const traza: TrazaMapa = {
      id: 't1',
      puntos: [
        { lat: -33.4489, lng: -70.6693 },
        { lat: 0, lng: 0 },
      ],
    };

    const modelo = construirModelo([], [traza], null);

    expect(modelo.lineas).toHaveLength(0);
    // El punto sobreviviente tampoco entra al encuadre: no hay linea que mostrar.
    expect(modelo.encuadre).toHaveLength(0);
    expect(modelo.vacio).toBe(true);
  });

  it('dibuja el recorrido y lo mete completo en el encuadre', () => {
    const traza: TrazaMapa = {
      id: 't1',
      variante: 'recorrido',
      puntos: [
        { lat: -33.4489, lng: -70.6693 },
        { lat: -33.4492, lng: -70.6698 },
        { lat: -33.4495, lng: -70.6701 },
      ],
    };

    const modelo = construirModelo([PORTERIA], [traza], null);

    expect(modelo.lineas).toHaveLength(1);
    expect(modelo.lineas[0]?.coordenadas).toHaveLength(3);
    expect(modelo.lineas[0]?.variante).toBe('recorrido');
    // Tres de la traza mas la marca: el guardia desviado no queda fuera de pantalla.
    expect(modelo.encuadre).toHaveLength(4);
  });

  it('trata la traza sin variante como recorrido', () => {
    const modelo = construirModelo(
      [],
      [
        {
          id: 't1',
          puntos: [
            { lat: -33.4489, lng: -70.6693 },
            { lat: -33.4492, lng: -70.6698 },
          ],
        },
      ],
      null,
    );

    expect(modelo.lineas[0]?.variante).toBe('recorrido');
  });

  it('usa el centro cuando no hay nada que encuadrar', () => {
    const modelo = construirModelo([], [], { lat: -33.4489, lng: -70.6693 });

    expect(modelo.encuadre).toHaveLength(0);
    expect(modelo.centro).toEqual([-33.4489, -70.6693]);
    expect(modelo.vacio).toBe(false);
  });

  it('ignora un centro sin coordenada utilizable', () => {
    expect(construirModelo([], [], { lat: 0, lng: 0 }).centro).toBeNull();
    expect(construirModelo([], [], null).centro).toBeNull();
    expect(construirModelo([], [], undefined).vacio).toBe(true);
  });

  it('marca vacio cuando el recinto todavia no tiene ninguna ubicacion cargada', () => {
    const modelo = construirModelo([SIN_COORDENADA], [], null);

    expect(modelo.marcas).toHaveLength(0);
    expect(modelo.vacio).toBe(true);
  });
});

describe('firmaDelContenido', () => {
  it('no cambia cuando el contenido es el mismo en arreglos distintos', () => {
    const a = firmaDelContenido([{ ...PORTERIA }], [], { lat: -33.4, lng: -70.6 });
    const b = firmaDelContenido([{ ...PORTERIA }], [], { lat: -33.4, lng: -70.6 });

    expect(a).toBe(b);
  });

  it('cambia cuando se mueve un punto', () => {
    const antes = firmaDelContenido([PORTERIA], [], null);
    const despues = firmaDelContenido([{ ...PORTERIA, lat: -33.45 }], [], null);

    expect(antes).not.toBe(despues);
  });

  it('cambia cuando llega un punto nuevo a la traza', () => {
    const traza: TrazaMapa = {
      id: 't1',
      puntos: [
        { lat: -33.4489, lng: -70.6693 },
        { lat: -33.4492, lng: -70.6698 },
      ],
    };
    const conMas: TrazaMapa = {
      id: 't1',
      puntos: [...traza.puntos, { lat: -33.4495, lng: -70.6701 }],
    };

    expect(firmaDelContenido([], [traza], null)).not.toBe(firmaDelContenido([], [conMas], null));
  });

  it('cambia cuando cambia el texto del globo', () => {
    expect(firmaDelContenido([PORTERIA], [], null)).not.toBe(
      firmaDelContenido([{ ...PORTERIA, detalle: 'Marcado 23:40' }], [], null),
    );
  });
});
