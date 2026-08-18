import type { CrashEvent } from './crash-event';
import { parseSentryDsn } from './crash-reporting.config';
import { huellaDeCaida } from './crash-fingerprint';
import { auditarTexto, depurarPila, depurarTexto } from './crash-scrubber';
import { cabecerasEnvelope, construirEnvelope, parsearCuadro } from './sentry-envelope';

function evento(cambios: Partial<CrashEvent> = {}): CrashEvent {
  return {
    eventId: 'a'.repeat(32),
    level: 'fatal',
    occurredAt: new Date('2026-08-03T12:00:00.000Z'),
    release: 'sentrycore-app@1.4.2',
    environment: 'staging',
    errorName: 'NfcBridgeError',
    errorMessage: 'no se pudo leer la etiqueta',
    stack: ['at leerTag (app://bundle.js:120:9)', 'at onPress (app://bundle.js:44:3)'],
    fingerprint: '0123456789abcdef',
    tags: {
      source: 'app',
      tenant_id: '3f0d8a1c-1111-4222-8333-444455556666',
      app_version: '1.4.2',
      device_model: 'Redmi 9A',
      android_version: '10',
      fatal: 'true',
    },
    requestId: 'req-123',
    ...cambios,
  };
}

/**
 * El cuerpo del envelope es JSON de Sentry: anidado y con forma que define un
 * tercero. Tiparlo entero seria copiar su esquema para probar cuatro campos.
 */
type CuerpoSentry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('parsearCuadro', () => {
  it('entiende la forma de V8', () => {
    expect(parsearCuadro('at leerTag (/app/dist/nfc.js:120:9)')).toEqual({
      filename: '/app/dist/nfc.js',
      function: 'leerTag',
      lineno: 120,
      colno: 9,
      in_app: true,
    });
  });

  it('entiende la forma de Hermes/React Native', () => {
    expect(parsearCuadro('onPress@app://bundle.js:44:3')).toEqual({
      filename: 'app://bundle.js',
      function: 'onPress',
      lineno: 44,
      colno: 3,
      in_app: true,
    });
  });

  it('marca fuera de la app lo que viene de librerias o del runtime', () => {
    expect(parsearCuadro('at Object.<anonymous> (/app/node_modules/rxjs/x.js:1:1)').in_app).toBe(
      false,
    );
    expect(parsearCuadro('at node:internal/process:12:1').in_app).toBe(false);
  });

  it('una linea que no reconoce NO se descarta: podria ser la unica util', () => {
    expect(parsearCuadro('linea rara sin forma conocida')).toEqual({
      filename: 'linea rara sin forma conocida',
      in_app: false,
    });
  });
});

describe('construirEnvelope', () => {
  it('arma las tres lineas del sobre', () => {
    const lineas = construirEnvelope(evento()).trimEnd().split('\n');

    expect(lineas).toHaveLength(3);
    expect(JSON.parse(lineas[0] ?? '')).toMatchObject({ event_id: 'a'.repeat(32) });
    expect(JSON.parse(lineas[1] ?? '')).toMatchObject({ type: 'event' });
  });

  it('la longitud declarada es la real en BYTES, no en caracteres', () => {
    // El mensaje lleva acentos y ñ A PROPOSITO: es el unico caso donde bytes y
    // caracteres no coinciden, y es lo que este test necesita comprobar.
    const lineas = construirEnvelope(
      evento({ errorMessage: 'la ronda no se cerró en el recinto de Ñuñoa' }),
    )
      .trimEnd()
      .split('\n');
    const cabecera = JSON.parse(lineas[1] ?? '') as { length: number };

    expect(cabecera.length).toBe(Buffer.byteLength(lineas[2] ?? '', 'utf8'));
    // Con acentos, bytes y caracteres NO coinciden: si esto fuera .length de
    // string, Sentry cortaria el cuerpo y descartaria el evento.
    expect(cabecera.length).toBeGreaterThan((lineas[2] ?? '').length);
  });

  it('el evento lleva version, modelo y version de Android', () => {
    const cuerpo = JSON.parse(
      construirEnvelope(evento()).trimEnd().split('\n')[2] ?? '',
    ) as CuerpoSentry;

    expect(cuerpo.tags.app_version).toBe('1.4.2');
    expect(cuerpo.contexts.device.model).toBe('Redmi 9A');
    expect(cuerpo.contexts.os).toEqual({ name: 'Android', version: '10' });
    expect(cuerpo.release).toBe('sentrycore-app@1.4.2');
    expect(cuerpo.tags.tenant_id).toBe('3f0d8a1c-1111-4222-8333-444455556666');
  });

  it('los cuadros van del mas antiguo al mas reciente, como los espera Sentry', () => {
    const cuerpo = JSON.parse(
      construirEnvelope(evento()).trimEnd().split('\n')[2] ?? '',
    ) as CuerpoSentry;
    const frames = cuerpo.exception.values[0].stacktrace.frames as Array<{ function: string }>;

    expect(frames.map((frame) => frame.function)).toEqual(['onPress', 'leerTag']);
  });

  it('no incluye el DSN en el cuerpo: la clave viaja solo en la cabecera HTTP', () => {
    expect(construirEnvelope(evento())).not.toContain('dsn');
  });

  it('una etiqueta vacia no se manda', () => {
    const cuerpo = JSON.parse(
      construirEnvelope(evento({ tags: { source: 'api', tenant_id: '' } }))
        .trimEnd()
        .split('\n')[2] ?? '',
    ) as CuerpoSentry;

    expect(cuerpo.tags).toEqual({ source: 'api' });
  });

  /**
   * El criterio de aceptacion del issue, ejecutable: se arma un evento con TODO
   * lo que no debe salir y se comprueba sobre el sobre ya serializado.
   */
  it('ningun dato personal del guardia llega al cuerpo del envio', () => {
    const mensajeSucio =
      'fallo al sincronizar del guardia jperez@empresa.cl (rut 12.345.678-9, ' +
      'tel +56912345678) en -33.44890,-70.66930 con token: aBcD1234EfGh5678';
    const pilaSucia = 'at sync (/home/jperez/app/sync.js:10:5)\nat tick (/app/dist/loop.js:3:1)';

    const errorMessage = depurarTexto(mensajeSucio);
    const stack = depurarPila(pilaSucia);
    const cuerpo = construirEnvelope(
      evento({
        errorMessage,
        stack,
        fingerprint: huellaDeCaida('SyncError', errorMessage, stack),
      }),
    );

    for (const dato of [
      'jperez@empresa.cl',
      '12.345.678-9',
      '+56912345678',
      '-33.44890',
      '-70.66930',
      'aBcD1234EfGh5678',
      'jperez',
    ]) {
      expect(cuerpo).not.toContain(dato);
    }
    expect(auditarTexto(errorMessage)).toEqual([]);
  });
});

describe('cabecerasEnvelope', () => {
  it('lleva la clave publica y la version del protocolo', () => {
    const cabeceras = cabecerasEnvelope(parseSentryDsn('https://laclave@host/9'));

    expect(cabeceras['content-type']).toBe('application/x-sentry-envelope');
    expect(cabeceras['x-sentry-auth']).toContain('sentry_version=7');
    expect(cabeceras['x-sentry-auth']).toContain('sentry_key=laclave');
  });
});
