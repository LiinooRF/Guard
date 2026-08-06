/**
 * Pruebas de la lógica pura del store de fotos pendientes (#70).
 *
 * El guardado/lectura en IndexedDB depende del navegador y se verifica aparte;
 * acá se prueba la decisión que gobierna la subida: separar las fotos que ya
 * tienen id de servidor (se pueden subir) de las que aún esperan que su novedad
 * sincronice.
 */

import {
  _reiniciarMemoria,
  clasificarPendientes,
  conSubidaExclusiva,
  type DestinoFoto,
  type FotoPendiente,
} from './guard-photo-store';

const foto = (
  clientEventId: string,
  serverId: string | null,
  destino: DestinoFoto = 'evento',
): FotoPendiente => ({
  clientEventId,
  serverId,
  takenAtDevice: '2026-08-04T23:41:00.000Z',
  destino,
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

  /**
   * El almacén ahora guarda dos cosas distintas: la foto de una novedad y la
   * del estado de la puerta en un punto. La clasificación es la misma —lo único
   * que decide es si ya hay id de servidor—, pero el destino tiene que viajar
   * intacto: es lo que después elige el endpoint de subida.
   */
  it('el destino sobrevive a la clasificación: decide a qué endpoint sube', () => {
    const { listas } = clasificarPendientes([
      foto('novedad', 'srv-1', 'evento'),
      foto('punto', 'srv-2', 'escaneo'),
    ]);
    expect(listas.map((f) => f.destino)).toEqual(['evento', 'escaneo']);
  });
});

/**
 * Cuando el veredicto de la cola llega mientras la foto del punto se está
 * procesando, quedan DOS caminos con el id del escaneo y los dos listos para
 * subirla: el del veredicto y el de la foto. Mandarla dos veces no es un envío
 * de más: la API rechaza con 409 el sha256 repetido (imagen reusada = fraude de
 * evidencia), y ese 409 le diría al guardia que falta una foto que sí llegó.
 */
describe('conSubidaExclusiva', () => {
  beforeEach(() => {
    _reiniciarMemoria();
  });

  it('dos caminos sobre la misma foto mandan UNA vez y ven el mismo desenlace', async () => {
    let envios = 0;
    let terminar!: (subida: boolean) => void;
    const enVuelo = new Promise<boolean>((resolver) => {
      terminar = resolver;
    });
    const subir = () => {
      envios += 1;
      return enVuelo;
    };

    const primero = conSubidaExclusiva('cliente-1', subir);
    const segundo = conSubidaExclusiva('cliente-1', subir);
    terminar(true);

    expect(await primero).toBe(true);
    expect(await segundo).toBe(true);
    expect(envios).toBe(1);
  });

  it('fotos distintas no se bloquean entre sí', async () => {
    const subidas: string[] = [];
    await Promise.all([
      conSubidaExclusiva('cliente-1', async () => {
        subidas.push('cliente-1');
        return true;
      }),
      conSubidaExclusiva('cliente-2', async () => {
        subidas.push('cliente-2');
        return true;
      }),
    ]);
    expect(subidas.sort()).toEqual(['cliente-1', 'cliente-2']);
  });

  it('terminada la subida, el reintento posterior vuelve a salir', async () => {
    let envios = 0;
    const subir = async () => {
      envios += 1;
      return false;
    };
    // La primera falló: la foto sigue en el teléfono y se reintenta sola. Si el
    // candado no se soltara, ese reintento no saldría nunca.
    expect(await conSubidaExclusiva('cliente-1', subir)).toBe(false);
    expect(await conSubidaExclusiva('cliente-1', subir)).toBe(false);
    expect(envios).toBe(2);
  });

  it('si la subida revienta, la foto no queda con el candado puesto', async () => {
    await expect(
      conSubidaExclusiva('cliente-1', () => Promise.reject(new Error('red caida'))),
    ).rejects.toThrow('red caida');
    expect(await conSubidaExclusiva('cliente-1', async () => true)).toBe(true);
  });
});
