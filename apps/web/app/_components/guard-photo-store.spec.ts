/**
 * Pruebas de la lógica pura del store de fotos pendientes (#70).
 *
 * El guardado/lectura en IndexedDB depende del navegador y se verifica aparte;
 * acá se prueba la decisión que gobierna la subida: separar las fotos que ya
 * tienen id de servidor (se pueden subir) de las que aún esperan que su novedad
 * sincronice.
 */

import { clasificarPendientes, type FotoPendiente } from './guard-photo-store';

const foto = (clientEventId: string, serverId: string | null): FotoPendiente => ({
  clientEventId,
  serverId,
  takenAtDevice: '2026-08-04T23:41:00.000Z',
});

describe('clasificarPendientes', () => {
  it('las que tienen serverId van a "listas" y el resto a "esperando"', () => {
    const { listas, esperando } = clasificarPendientes([
      foto('a', 'srv-1'),
      foto('b', null),
      foto('c', 'srv-3'),
    ]);
    expect(listas.map((f) => f.clientEventId)).toEqual(['a', 'c']);
    expect(esperando.map((f) => f.clientEventId)).toEqual(['b']);
  });

  it('sin pendientes devuelve dos listas vacías', () => {
    expect(clasificarPendientes([])).toEqual({ listas: [], esperando: [] });
  });

  it('si ninguna sincronizó todavía, todas quedan esperando', () => {
    const { listas, esperando } = clasificarPendientes([foto('a', null), foto('b', null)]);
    expect(listas).toHaveLength(0);
    expect(esperando).toHaveLength(2);
  });
});
