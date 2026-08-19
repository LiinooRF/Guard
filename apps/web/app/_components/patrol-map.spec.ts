/**
 * Pruebas unitarias para el mapa de rondas y trazado de recorridos (#76 / #95 / #134).
 *
 * Cubre:
 * - Secuencia de checkpoints de la ruta (polyline patrón 'ruta' vs breadcrumb real 'recorrido').
 * - Manejo de puntos interiores / subterráneos sin coordenadas GPS.
 * - Estilo sobrio y diferenciado (línea punteada para planificado, sólida para real).
 * - Generación de marcas y leyendas contextuales según estado.
 */

import {
  marcasDeCheckpoints,
  resumenDeCheckpoints,
  trazaDePatronCheckpoints,
  trazaDeRecorrido,
  type CheckpointTrack,
  type PuntoTrack,
} from './recorrido-modelo';
import { marcasDeRuta, trazaDeRutaPatron, leyendaDeRuta } from './guard-mapa-modelo';
import type { PuntoRuta } from './guard-shift-state';

describe('PatrolMap - Trazado de ruta y checkpoints', () => {
  const checkpoints: CheckpointTrack[] = [
    { id: 'cp-1', name: 'Acceso Principal', position: 1, latitude: -33.4489, longitude: -70.6693, scanned: true },
    { id: 'cp-2', name: 'Bodega Subterránea -1', position: 2, latitude: null, longitude: null, scanned: true }, // Subterráneo sin GPS
    { id: 'cp-3', name: 'Patio Carga', position: 3, latitude: -33.4495, longitude: -70.6701, scanned: false, isCritical: true },
    { id: 'cp-4', name: 'Caseta Guardia', position: 4, latitude: -33.4501, longitude: -70.6710, scanned: false },
  ];

  it('conecta los checkpoints con GPS en la traza planificada respetando el orden numérico', () => {
    const traza = trazaDePatronCheckpoints(checkpoints);
    expect(traza).not.toBeNull();
    expect(traza!.id).toBe('ruta-patron');
    expect(traza!.variante).toBe('ruta');
    // cp-2 no tiene coordenadas, la traza conecta cp-1 -> cp-3 -> cp-4
    expect(traza!.puntos).toHaveLength(3);
    expect(traza!.puntos[0]).toEqual({ lat: -33.4489, lng: -70.6693 });
    expect(traza!.puntos[1]).toEqual({ lat: -33.4495, lng: -70.6701 });
    expect(traza!.puntos[2]).toEqual({ lat: -33.4501, lng: -70.6710 });
  });

  it('resumenDeCheckpoints contabiliza con precisión puntos con y sin GPS', () => {
    const resumen = resumenDeCheckpoints(checkpoints);
    expect(resumen.total).toBe(4);
    expect(resumen.conUbicacion).toBe(3);
    expect(resumen.sinUbicacion).toBe(1); // Punto subterráneo
    expect(resumen.cumplidos).toBe(2);
    expect(resumen.pendientes).toBe(2);
  });

  it('genera marcas con variantes correctas para cumplidos, críticos y pendientes', () => {
    const marcas = marcasDeCheckpoints(checkpoints);
    expect(marcas).toHaveLength(3); // Solo los 3 con GPS
    expect(marcas[0]).toMatchObject({ id: 'cp-1', numero: 1, variante: 'fin', detalle: 'Cumplido' });
    expect(marcas[1]).toMatchObject({ id: 'cp-3', numero: 3, variante: 'alerta', detalle: 'Pendiente' });
    expect(marcas[2]).toMatchObject({ id: 'cp-4', numero: 4, variante: 'punto', detalle: 'Pendiente' });
  });
});

describe('PatrolMap - Breadcrumb de GPS en vivo (traza real)', () => {
  const puntosGps: PuntoTrack[] = [
    { recordedAt: '2026-08-19T13:00:00Z', latitude: -33.4489, longitude: -70.6693, accuracyM: 10, batteryPct: 90 },
    { recordedAt: '2026-08-19T13:01:00Z', latitude: -33.4492, longitude: -70.6697, accuracyM: 15, batteryPct: 89 },
    { recordedAt: '2026-08-19T13:02:00Z', latitude: -33.4495, longitude: -70.6701, accuracyM: 12, batteryPct: 88 },
  ];

  it('genera una polilínea continua de variante "recorrido" con el camino real del guardia', () => {
    const traza = trazaDeRecorrido(puntosGps);
    expect(traza).not.toBeNull();
    expect(traza!.id).toBe('recorrido');
    expect(traza!.variante).toBe('recorrido');
    expect(traza!.puntos).toHaveLength(3);
  });

  it('descarta puntos inválidos en el breadcrumb sin romper la continuidad', () => {
    const conError: PuntoTrack[] = [
      puntosGps[0]!,
      { recordedAt: '2026-08-19T13:01:30Z', latitude: 0, longitude: 0, accuracyM: null, batteryPct: 88 },
      puntosGps[2]!,
    ];
    const traza = trazaDeRecorrido(conError);
    expect(traza!.puntos).toHaveLength(2);
    expect(traza!.puntos[0]).toEqual({ lat: -33.4489, lng: -70.6693 });
    expect(traza!.puntos[1]).toEqual({ lat: -33.4495, lng: -70.6701 });
  });
});

describe('PatrolMap - Visor del guardia (GuardMapa)', () => {
  const puntosRuta: PuntoRuta[] = [
    { id: 'r-1', name: 'Entrada', position: 1, latitude: -33.4489, longitude: -70.6693 },
    { id: 'r-2', name: 'Estacionamiento -1', position: 2 }, // Sin GPS
    { id: 'r-3', name: 'Salida Emergencia', position: 3, latitude: -33.4501, longitude: -70.6710 },
  ];

  it('destaca el siguiente punto a escanear con variante "inicio"', () => {
    const escaneados = new Set<string>();
    const marcas = marcasDeRuta(puntosRuta, escaneados, 'r-1');
    expect(marcas).toHaveLength(2); // r-1 y r-3
    expect(marcas[0]!.variante).toBe('inicio');
    expect(marcas[0]!.detalle).toBe('Siguiente punto');
  });

  it('genera la traza patrón de la ruta del guardia', () => {
    const traza = trazaDeRutaPatron(puntosRuta);
    expect(traza).not.toBeNull();
    expect(traza!.puntos).toHaveLength(2);
  });

  it('genera la leyenda solo con estados presentes', () => {
    const leyenda = leyendaDeRuta(puntosRuta, new Set(['r-1']), 'r-3');
    expect(leyenda.map((l) => l.etiqueta)).toEqual(['Siguiente punto', 'Cumplido']);
  });
});
