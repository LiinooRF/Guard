import { armarSobre, leerMensajePortal, leerMensajeShell, TIPOS_SHELL } from './protocol';

/**
 * `track.point` tiene que SOBREVIVIR al validador (#280).
 *
 * El defecto que vigila esta prueba es el mismo que ya nos costo la traza una
 * vez, en el sentido contrario: un tipo de mensaje declarado en el catalogo
 * pero SIN su caso en el switch de payload cae al `default: return false` y se
 * descarta **en silencio**. No hay excepcion, no hay log, no hay nada: el
 * emisor nativo manda cada posicion, el portal las tira, y el mapa del
 * supervisor queda vacio sin que nadie sepa por que.
 *
 * Por eso el ultimo test no mira `track.point` sino TODO el catalogo: un tipo
 * nuevo que alguien agregue a `TIPOS_SHELL` sin su validacion falla aca, en vez
 * de fallar callado en terreno seis semanas despues.
 */
/** Se arma con el constructor REAL: imitar el sobre a mano prueba el imitador. */
function sobre(type: string, payload: unknown) {
  return JSON.stringify(armarSobre(type, payload as Record<string, unknown>, { prefijo: 'trk' }));
}

const PUNTO = {
  recordedAt: '2026-08-15T03:20:00.000Z',
  latitude: -33.4489,
  longitude: -70.6693,
  accuracyM: 12.5,
};

describe('track.point atraviesa el validador del portal (#280)', () => {
  it('acepta una posicion valida', () => {
    const leido = leerMensajeShell(sobre('track.point', PUNTO));
    expect(leido.ok).toBe(true);
  });

  it('acepta una posicion sin precision: accuracyM es opcional', () => {
    const { accuracyM, ...sinPrecision } = PUNTO;
    expect(accuracyM).toBeDefined();
    expect(leerMensajeShell(sobre('track.point', sinPrecision)).ok).toBe(true);
  });

  it('rechaza coordenadas fuera de rango, no solo de otro tipo', () => {
    // Un GPS que devuelve basura no puede entrar a la traza como si fuera una
    // posicion real del guardia.
    expect(leerMensajeShell(sobre('track.point', { ...PUNTO, latitude: 91 })).ok).toBe(false);
    expect(leerMensajeShell(sobre('track.point', { ...PUNTO, longitude: -181 })).ok).toBe(false);
    expect(leerMensajeShell(sobre('track.point', { ...PUNTO, latitude: 'sur' })).ok).toBe(false);
  });

  it('rechaza una fecha que no es fecha', () => {
    expect(leerMensajeShell(sobre('track.point', { ...PUNTO, recordedAt: 'ayer' })).ok).toBe(false);
  });

  it('rechaza una precision negativa', () => {
    expect(leerMensajeShell(sobre('track.point', { ...PUNTO, accuracyM: -1 })).ok).toBe(false);
  });

  it('NINGUN tipo del catalogo se descarta en silencio por no tener validacion', () => {
    // Descubre solo: si manana alguien agrega un tipo a TIPOS_SHELL y se olvida
    // del caso en el switch, este test lo caza. Se le pasa un payload vacio a
    // proposito: lo que se mide no es que lo acepte, sino que exista una razon
    // escrita para rechazarlo y no el `default` mudo.
    const sinValidacion = TIPOS_SHELL.filter((tipo) => {
      const conPayloadVacio = leerMensajeShell(sobre(tipo, {}));
      const conPayloadPlausible = leerMensajeShell(sobre(tipo, PUNTO));
      // Un tipo con validacion propia acepta alguno de los dos, o rechaza los
      // dos por su contenido. Uno SIN validacion rechaza todo siempre igual.
      return !conPayloadVacio.ok && !conPayloadPlausible.ok;
    });
    // Los que legitimamente rechazan ambos payloads se enumeran aca, y la lista
    // obliga a pensar antes de agregar uno.
    const esperados = [
      'nfc.scan.result', 'qr.scan.result', 'nfc.scan.error', 'qr.scan.error',
      'permission.result', 'offline.route.saved', 'sync.queue.enqueued',
      'sync.queue.flushed', 'device.signature.registered', 'connectivity.state',
      'error', 'hello.ack', 'ready', 'incompatible',
    ];
    expect(sinValidacion.filter((t) => !esperados.includes(t))).toEqual([]);
  });
});

describe('track.start acepta destino para el segundo plano', () => {
  it('deja pasar el mensaje CON patrolId y apiBaseUrl', () => {
    const sobre = armarSobre(
      'track.start',
      {
        intervalSeconds: 60,
        patrolId: 'f786680e-0000-4000-8000-000000000001',
        apiBaseUrl: 'https://sentrycore.voxtilabs.cl/api',
      },
      { prefijo: 'web' },
    );

    const leido = leerMensajePortal(JSON.stringify(sobre));

    expect(leido.ok).toBe(true);
  });

  it('sigue dejando pasar el mensaje SIN destino, como lo manda un portal viejo', () => {
    // Esto es lo que garantiza que una app ya instalada no se rompa: el shell
    // recibe lo de siempre y se queda con el muestreo de pantalla encendida.
    const sobre = armarSobre('track.start', { intervalSeconds: 60 }, { prefijo: 'web' });

    const leido = leerMensajePortal(JSON.stringify(sobre));

    expect(leido.ok).toBe(true);
  });

  it('rechaza un destino que no es texto', () => {
    const sobre = armarSobre(
      'track.start',
      { intervalSeconds: 60, patrolId: 42, apiBaseUrl: 'https://x.cl/api' },
      { prefijo: 'web' },
    );

    const leido = leerMensajePortal(JSON.stringify(sobre));

    expect(leido.ok).toBe(false);
  });
});
