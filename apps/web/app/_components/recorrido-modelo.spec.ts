import {
  marcasDeCheckpoints,
  puntosDibujables,
  trazaDePatronCheckpoints,
  trazaDeRecorrido,
  type CheckpointTrack,
  type PuntoTrack,
} from './recorrido-modelo';

const p = (lat: number, lng: number): PuntoTrack => ({
  recordedAt: '2026-08-04T23:41:00.000Z',
  latitude: lat,
  longitude: lng,
  accuracyM: 10,
  batteryPct: 80,
});

const cp = (
  id: string,
  pos: number,
  coords?: [number, number],
  scanned = false,
  isCritical = false,
): CheckpointTrack => ({
  id,
  name: `Checkpoint ${id}`,
  position: pos,
  latitude: coords ? coords[0] : null,
  longitude: coords ? coords[1] : null,
  scanned,
  isCritical,
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

describe('marcasDeCheckpoints', () => {
  it('genera marcas ordenadas con variante según estado y criticidad', () => {
    const checkpoints = [
      cp('1', 1, [-33.45, -70.66], true, false),
      cp('2', 2, [-33.451, -70.661], false, true),
      cp('3', 3, [-33.452, -70.662], false, false),
    ];
    const marcas = marcasDeCheckpoints(checkpoints);
    expect(marcas).toHaveLength(3);
    expect(marcas[0]).toMatchObject({ numero: 1, variante: 'fin', detalle: 'Cumplido' });
    expect(marcas[1]).toMatchObject({ numero: 2, variante: 'alerta', detalle: 'Pendiente' });
    expect(marcas[2]).toMatchObject({ numero: 3, variante: 'punto', detalle: 'Pendiente' });
  });

  it('omite checkpoints sin coordenadas válidas', () => {
    const checkpoints = [
      cp('1', 1, [-33.45, -70.66]),
      cp('sin', 2),
      cp('cero', 3, [0, 0]),
    ];
    const marcas = marcasDeCheckpoints(checkpoints);
    expect(marcas).toHaveLength(1);
    expect(marcas[0]!.id).toBe('1');
  });
});

describe('trazaDePatronCheckpoints', () => {
  it('genera traza con variante "ruta" conectando los checkpoints en orden', () => {
    const checkpoints = [
      cp('3', 3, [-33.452, -70.662]),
      cp('1', 1, [-33.45, -70.66]),
      cp('2', 2, [-33.451, -70.661]),
    ];
    const traza = trazaDePatronCheckpoints(checkpoints);
    expect(traza).not.toBeNull();
    expect(traza!.variante).toBe('ruta');
    expect(traza!.puntos).toEqual([
      { lat: -33.45, lng: -70.66 },
      { lat: -33.451, lng: -70.661 },
      { lat: -33.452, lng: -70.662 },
    ]);
  });

  it('devuelve null si hay menos de dos checkpoints con coordenadas válidas', () => {
    expect(trazaDePatronCheckpoints([cp('1', 1, [-33.45, -70.66])])).toBeNull();
    expect(trazaDePatronCheckpoints([cp('1', 1, [-33.45, -70.66]), cp('2', 2)])).toBeNull();
  });
});

describe('puntosDibujables', () => {
  it('cuenta solo los de coordenada válida', () => {
    expect(puntosDibujables([p(-33.45, -70.66), p(0, 0), p(-33.4, -70.6)])).toBe(2);
  });
});
