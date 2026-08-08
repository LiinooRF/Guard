import { resumirEstadoServidor } from './sync-estado-modelo';

describe('resumirEstadoServidor', () => {
  it('EL BUG: dos escaneos directos con cola vacía ya no son "0 registros"', () => {
    /*
     * Visto en un teléfono real: dos escaneos aceptados en la base, cola
     * offline vacía, y el panel decía "El servidor todavía no tiene registros
     * tuyos" al lado de "Todo subido". Confundió al guardia y desvió un
     * diagnóstico entero. El contador de la cola no cuenta registros directos.
     */
    const resumen = resumirEstadoServidor({
      windowHours: 24,
      operations: { applied: 0, duplicated: 0, rejected: 0 },
      records: { total: 2, lastReceivedAt: '2026-08-08T15:55:13.000Z' },
      lastSyncedAt: null,
    });
    expect(resumen.confirmadas).toBe(2);
    expect(resumen.lastSyncedAt).toBe('2026-08-08T15:55:13.000Z');
  });

  it('con una API vieja sin records, cae al conteo de la cola sin inventar', () => {
    const resumen = resumirEstadoServidor({
      windowHours: 24,
      operations: { applied: 3, duplicated: 1, rejected: 0 },
      lastSyncedAt: '2026-08-08T10:00:00.000Z',
    });
    expect(resumen.confirmadas).toBe(4);
    expect(resumen.lastSyncedAt).toBe('2026-08-08T10:00:00.000Z');
  });

  it('records manda sobre la cola aunque la cola tenga más', () => {
    // La cola puede acumular reintentos duplicados; los registros son la verdad.
    const resumen = resumirEstadoServidor({
      operations: { applied: 9, duplicated: 5 },
      records: { total: 6, lastReceivedAt: null },
    });
    expect(resumen.confirmadas).toBe(6);
  });
});
