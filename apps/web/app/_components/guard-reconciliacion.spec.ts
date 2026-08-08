import {
  reconciliarConServidor,
  type EstadoRonda,
  type PuntoRuta,
  type RegistroPunto,
} from './guard-shift-state';

/*
 * Los dos daños que esta función existe para impedir se vieron en un teléfono
 * real (moto g35, 2026-08-08):
 *
 *   1. El fantasma: "PUNTO 2 DE 2" saliendo de un login fresco, porque el
 *      avance local sobrevivía a reinstalar la app y nadie lo cotejaba.
 *   2. El punto atascado: un escaneo que el teléfono daba por confirmado y el
 *      servidor no tenía quedaba como hecho PARA SIEMPRE — el guardia no podía
 *      volver a marcarlo.
 */

const punto = (id: string, scannedAt: string | null = null): PuntoRuta => ({
  id,
  name: `Punto ${id}`,
  position: 1,
  scannedAt,
});

const registro = (extra: Partial<RegistroPunto> = {}): RegistroPunto => ({
  estado: 'escaneado',
  confirmado: true,
  anomalias: [],
  scannedAt: '2026-08-08T03:00:00.000Z',
  clientScanId: 'f20d8eb5-8023-483b-9e24-53d383078968',
  metodo: 'nfc',
  ...extra,
});

const estadoCon = (
  puntos: Record<string, RegistroPunto>,
  extra: Partial<EstadoRonda> = {},
): EstadoRonda => ({ patrolId: 'patrol-id', puntos, novedades: [], ...extra });

describe('reconciliarConServidor', () => {
  it('un registro "confirmado" que el servidor no tiene es un fantasma: vuelve a pendiente', () => {
    const resultado = reconciliarConServidor(
      estadoCon({ 'cp-1': registro({ confirmado: true }) }),
      [punto('cp-1', null), punto('cp-2', null)],
    );
    // El punto queda SIN registro local: para la pantalla está pendiente y el
    // guardia puede volver a marcarlo. Antes quedaba hecho para siempre.
    expect(resultado.puntos['cp-1']).toBeUndefined();
  });

  it('lo que está en cola (confirmado: false) se respeta: sin señal el teléfono es la única memoria', () => {
    const enCola = registro({ confirmado: false });
    const resultado = reconciliarConServidor(
      estadoCon({ 'cp-1': enCola }),
      [punto('cp-1', null)],
    );
    expect(resultado.puntos['cp-1']).toEqual(enCola);
  });

  it('lo que el servidor confirma queda confirmado aunque el teléfono no lo supiera', () => {
    const resultado = reconciliarConServidor(
      estadoCon({}),
      [punto('cp-1', '2026-08-08T15:49:31.438Z')],
    );
    expect(resultado.puntos['cp-1']).toMatchObject({
      estado: 'escaneado',
      confirmado: true,
      scannedAt: '2026-08-08T15:49:31.438Z',
    });
    // Sin inventar método: decir "NFC" sin saberlo es justo lo que la ficha de
    // `metodo` prohíbe — un QR fotografiado pasaría por etiqueta.
    expect(resultado.puntos['cp-1']?.metodo).toBeUndefined();
  });

  it('cuando los dos saben del punto, se conserva lo local (método, foto) y se confirma', () => {
    const local = registro({ confirmado: false, fotoRequerida: true, fotoSubida: false });
    const resultado = reconciliarConServidor(
      estadoCon({ 'cp-1': local }),
      [punto('cp-1', '2026-08-08T15:49:31.438Z')],
    );
    expect(resultado.puntos['cp-1']).toMatchObject({
      confirmado: true,
      metodo: 'nfc',
      fotoRequerida: true,
      fotoSubida: false,
    });
  });

  it('un cierre local "confirmado" con la ronda abierta en el servidor es de otra sesión: se descarta', () => {
    const resultado = reconciliarConServidor(
      estadoCon(
        {},
        {
          cierre: {
            cerradaAt: '2026-08-08T15:55:16.307Z',
            scanned: 2, expected: 2, faltantes: [], pct: 100,
            alertaEnviada: false, confirmado: true,
          },
        },
      ),
      [punto('cp-1', null)],
    );
    expect(resultado.cierre).toBeUndefined();
  });

  it('un cierre en cola se respeta: puede estar esperando señal', () => {
    const cierre = {
      cerradaAt: '2026-08-08T15:55:16.307Z',
      scanned: 2, expected: 2, faltantes: [], alertaEnviada: false, confirmado: false,
    };
    const resultado = reconciliarConServidor(estadoCon({}, { cierre }), [punto('cp-1', null)]);
    expect(resultado.cierre).toEqual(cierre);
  });

  it('un punto local que ya no está en la ruta del servidor se descarta', () => {
    const resultado = reconciliarConServidor(
      estadoCon({ 'cp-viejo': registro() }),
      [punto('cp-1', null)],
    );
    expect(resultado.puntos['cp-viejo']).toBeUndefined();
  });
});
