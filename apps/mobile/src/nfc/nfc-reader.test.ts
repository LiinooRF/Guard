import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorEscaneo } from '../bridge/native';
import { crearLectorNfc, type PuertoNfc } from './nfc-reader';

function puerto(parcial: Partial<PuertoNfc> = {}): PuertoNfc {
  return {
    iniciar: async () => undefined,
    soportado: async () => true,
    activado: async () => true,
    esperarEtiqueta: async () => ({ id: '04:aa:bb:cc:dd:ee:ff' }),
    cancelar: async () => undefined,
    posicion: async () => ({ latitude: -33.45, longitude: -70.66, accuracyM: 8 }),
    confirmar: () => undefined,
    firmar: async () => ({
      clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
      deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
      signature: 'a'.repeat(64),
    }),
    clasificarError: () => 'desconocido',
    ahora: () => new Date('2026-08-04T12:00:00.000Z'),
    ...parcial,
  };
}

test('normaliza el UID NTAG y adjunta GPS y timestamp del dispositivo', async () => {
  let vibraciones = 0;
  const lector = crearLectorNfc(puerto({ confirmar: () => { vibraciones += 1; } }));

  assert.deepEqual(await lector.escanear(1_000), {
    uid: '04AABBCCDDEEFF',
    tech: 'nfc',
    scannedAt: '2026-08-04T12:00:00.000Z',
    latitude: -33.45,
    longitude: -70.66,
    accuracyM: 8,
    clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
    deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
    signature: 'a'.repeat(64),
  });
  assert.equal(vibraciones, 1);
});

test('un teléfono sin antena falla sin intentar leer y ofrece QR', async () => {
  let intentoLectura = false;
  const lector = crearLectorNfc(puerto({
    soportado: async () => false,
    esperarEtiqueta: async () => { intentoLectura = true; return null; },
  }));

  await assert.rejects(
    lector.escanear(1_000),
    (error: unknown) => error instanceof ErrorEscaneo &&
      error.codigo === 'nfc-no-disponible' && /QR/.test(error.message),
  );
  assert.equal(intentoLectura, false);
});

test('distingue radio apagada, timeout y UID ilegible', async (t) => {
  await t.test('radio apagada', async () => {
    const lector = crearLectorNfc(puerto({ activado: async () => false }));
    await assert.rejects(lector.escanear(100), (e: unknown) =>
      e instanceof ErrorEscaneo && e.codigo === 'nfc-desactivado' && !e.reintentable);
  });
  await t.test('timeout', async () => {
    const lector = crearLectorNfc(puerto({ esperarEtiqueta: () => new Promise(() => undefined) }));
    await assert.rejects(lector.escanear(5), (e: unknown) =>
      e instanceof ErrorEscaneo && e.codigo === 'timeout' && e.reintentable);
  });
  await t.test('UID ilegible', async () => {
    const lector = crearLectorNfc(puerto({ esperarEtiqueta: async () => ({ id: 'no-es-uid' }) }));
    await assert.rejects(lector.escanear(100), (e: unknown) =>
      e instanceof ErrorEscaneo && e.codigo === 'etiqueta-ilegible');
  });
});

test('cancelar interrumpe la sesión activa y siempre libera el lector', async () => {
  let rechazarLectura: ((error: Error) => void) | undefined;
  let cancelaciones = 0;
  const lector = crearLectorNfc(puerto({
    esperarEtiqueta: () => new Promise((_, reject) => { rechazarLectura = reject; }),
    cancelar: async () => {
      cancelaciones += 1;
      rechazarLectura?.(new Error('cancelled'));
    },
  }));
  const lectura = lector.escanear(10_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  lector.cancelar();

  await assert.rejects(lectura, (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'cancelado');
  assert.ok(cancelaciones >= 1);
});

test('rechaza un segundo escaneo concurrente sin cancelar el primero', async () => {
  let resolver: ((tag: { id: string }) => void) | undefined;
  const lector = crearLectorNfc(puerto({
    esperarEtiqueta: () => new Promise((resolve) => { resolver = resolve; }),
  }));
  const primero = lector.escanear(1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(lector.escanear(1_000), (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'error-desconocido');
  resolver?.({ id: '04AABBCC' });
  await primero;
});
