/**
 * Pruebas del modelo de la traza del recorrido (#134): el filtro de coordenadas
 * y cuándo hay una línea que dibujar.
 */

import { puntosDibujables, trazaDeRecorrido, type PuntoTrack } from './recorrido-modelo';

const p = (lat: number, lng: number): PuntoTrack => ({
  recordedAt: '2026-08-04T23:41:00.000Z',
  latitude: lat,
  longitude: lng,
  accuracyM: 10,
  batteryPct: 80,
});

describe('trazaDeRecorrido', () => {
  it('arma una traza "recorrido" con los puntos válidos, en orden', () => {
    const traza = trazaDeRecorrido([p(-33.45, -70.66), p(-33.451, -70.661), p(-33.452, -70.662)]);
    expect(traza).not.toBeNull();
    expect(traza!.variante).toBe('recorrido');
    expect(traza!.puntos).toHaveLength(3);
    expect(traza!.puntos[0]).toEqual({ lat: -33.45, lng: -70.66 });
  });

  it('descarta los puntos con coordenadas inválidas (0,0)', () => {
    const traza = trazaDeRecorrido([p(-33.45, -70.66), p(0, 0), p(-33.452, -70.662)]);
    expect(traza!.puntos).toHaveLength(2);
  });

  it('con menos de dos puntos válidos no hay recorrido que dibujar', () => {
    expect(trazaDeRecorrido([p(-33.45, -70.66)])).toBeNull();
    expect(trazaDeRecorrido([])).toBeNull();
    expect(trazaDeRecorrido([p(-33.45, -70.66), p(0, 0)])).toBeNull();
  });
});

describe('puntosDibujables', () => {
  it('cuenta solo los de coordenada válida', () => {
    expect(puntosDibujables([p(-33.45, -70.66), p(0, 0), p(-33.4, -70.6)])).toBe(2);
  });
});
