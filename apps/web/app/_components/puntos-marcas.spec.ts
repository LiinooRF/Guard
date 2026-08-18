/**
 * El punto recien creado tiene que verse en el mapa.
 *
 * Reportado en terreno: el pin aparece al marcarlo en el formulario y despues de
 * guardar no aparece nunca mas, ni creando a mano ni importando por CSV. El
 * punto SI quedaba guardado con coordenadas validas —la API lo devolvia bien—:
 * lo que faltaba era dibujarlo. `CoordinateMap` recibia solo la coordenada del
 * formulario, que al guardar se limpia.
 *
 * Por eso hay dos pruebas de distinta naturaleza:
 *
 * 1. El modelo (`marcasDePuntos`), que es logica pura.
 * 2. **El cableado**, leyendo el fuente de las dos pantallas. Es la parte que de
 *    verdad estaba rota, y ninguna prueba del modelo la ve: la funcion podia
 *    estar perfecta y no llamarla nadie. Es la quinta vez en este repo que una
 *    pieza entera queda construida y sin enchufar (#271, #275, #280, #79), asi
 *    que la comprobacion que hace falta es «alguien la llama», no «funciona».
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { marcasDePuntos, type PuntoDibujable } from './puntos-marcas';

const punto = (extra: Partial<PuntoDibujable> = {}): PuntoDibujable => ({
  id: 'p1',
  name: 'Portería',
  suggestedOrder: 1,
  kind: 'normal',
  latitude: -33.4489,
  longitude: -70.6693,
  ...extra,
});

describe('marcasDePuntos', () => {
  it('dibuja los puntos que tienen coordenadas', () => {
    expect(marcasDePuntos([punto()])).toEqual([
      {
        id: 'p1',
        latitude: -33.4489,
        longitude: -70.6693,
        label: '1. Portería',
        variante: 'punto',
      },
    ]);
  });

  it('deja fuera los que no tienen ubicación, en vez de inventarles una', () => {
    const sinUbicacion = punto({ id: 'p2', latitude: null, longitude: null });
    const aMedias = punto({ id: 'p3', longitude: null });
    expect(marcasDePuntos([sinUbicacion, aMedias])).toEqual([]);
  });

  it('distingue el acceso crítico, que la leyenda pinta aparte', () => {
    const [marca] = marcasDePuntos([punto({ kind: 'acceso_critico' })]);
    expect(marca?.variante).toBe('alerta');
  });

  it('rotula con el orden y el nombre, que es lo que identifica al punto en terreno', () => {
    const [marca] = marcasDePuntos([punto({ suggestedOrder: 7, name: 'Patio norte' })]);
    expect(marca?.label).toBe('7. Patio norte');
  });
});

describe('las pantallas que crean puntos le pasan los puntos al mapa', () => {
  const pantallas = ['puntos-supervisor.tsx', 'site-management.tsx'];

  it.each(pantallas)('%s monta CoordinateMap con markers', (archivo) => {
    const fuente = readFileSync(join(__dirname, archivo), 'utf8');
    const montajes = fuente.match(/<CoordinateMap[\s\S]*?\/>/g) ?? [];
    expect(montajes.length).toBeGreaterThan(0);

    // El mapa del formulario de PUNTOS es el que tiene que mostrarlos. La
    // pantalla del admin monta ademas el mapa del recinto, que ubica el recinto
    // y no lleva marcas: se distingue por su onPick.
    const deCheckpoints = montajes.filter((montaje) => !/setSiteCoordinates|siteCoordinates/.test(montaje));
    expect(deCheckpoints.length).toBeGreaterThan(0);
    for (const montaje of deCheckpoints) {
      expect(montaje).toMatch(/markers=\{marcasDePuntos\(/);
    }
  });
});
