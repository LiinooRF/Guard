import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorEscaneo } from '../bridge/native';
import { crearLectorQr, type PuertoQr } from './qr-reader';

const CODIGO = 'VXQ-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function puerto(parcial: Partial<PuertoQr> = {}): PuertoQr {
  return {
    permisoCamara: async () => 'concedido',
    abrirCamara: () => undefined,
    cerrarCamara: () => undefined,
    esperarCodigo: async () => CODIGO,
    posicion: async () => ({ latitude: -33.45, longitude: -70.66, accuracyM: 8 }),
    confirmar: () => undefined,
    firmar: async () => ({
      clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
      deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
      signature: 'b'.repeat(64),
    }),
    ahora: () => new Date('2026-08-05T12:00:00.000Z'),
    ...parcial,
  };
}

test('entrega la lectura marcada como qr, con GPS y firma del dispositivo', async () => {
  let confirmaciones = 0;
  const lector = crearLectorQr(puerto({ confirmar: () => { confirmaciones += 1; } }));

  assert.deepEqual(await lector.escanear(1_000), {
    uid: CODIGO,
    // Esto es lo que hace que el informe pueda distinguir la evidencia débil:
    // si acá dijera 'nfc', un QR fotografiado valdría lo mismo que la etiqueta.
    tech: 'qr',
    scannedAt: '2026-08-05T12:00:00.000Z',
    latitude: -33.45,
    longitude: -70.66,
    accuracyM: 8,
    clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
    deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
    signature: 'b'.repeat(64),
  });
  assert.equal(confirmaciones, 1);
});

test('firma lo que va a viajar: el mismo uid y method qr', async () => {
  let firmado: unknown;
  const lector = crearLectorQr(puerto({
    firmar: async (input) => {
      firmado = input;
      return {
        clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
        deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
        signature: 'b'.repeat(64),
      };
    },
  }));
  await lector.escanear(1_000);

  assert.deepEqual(firmado, {
    uid: CODIGO,
    method: 'qr',
    scannedAt: '2026-08-05T12:00:00.000Z',
    latitude: -33.45,
    longitude: -70.66,
    accuracyM: 8,
  });
});

test('un afiche pegado al lado no corta el escaneo: la cámara sigue mirando', async () => {
  const leidos = ['https://promo.example.cl', 'WIFI:S=Casa;T=WPA;P=1234;;', CODIGO];
  let indice = 0;
  let cierres = 0;
  const lector = crearLectorQr(puerto({
    esperarCodigo: async () => leidos[indice++]!,
    cerrarCamara: () => { cierres += 1; },
  }));

  const lectura = await lector.escanear(1_000);
  assert.equal(lectura.uid, CODIGO);
  // Los dos códigos ajenos se descartaron sin abrir y cerrar la cámara de nuevo.
  assert.equal(indice, 3);
  assert.equal(cierres, 1);
});

test('sin permiso de cámara dice qué hacer y distingue si se puede volver a pedir', async (t) => {
  await t.test('denegado esta vez: se puede reintentar', async () => {
    const lector = crearLectorQr(puerto({ permisoCamara: async () => 'denegado' }));
    await assert.rejects(lector.escanear(100), (e: unknown) =>
      e instanceof ErrorEscaneo && e.codigo === 'permiso-denegado' && e.reintentable);
  });

  await t.test('denegado para siempre: manda a Ajustes y no ofrece reintentar', async () => {
    let abrio = false;
    const lector = crearLectorQr(puerto({
      permisoCamara: async () => 'denegado-definitivo',
      abrirCamara: () => { abrio = true; },
    }));
    await assert.rejects(lector.escanear(100), (e: unknown) =>
      e instanceof ErrorEscaneo && e.codigo === 'permiso-denegado' &&
      !e.reintentable && /ajustes/i.test(e.message));
    // No se enciende una cámara que el sistema va a rechazar igual.
    assert.equal(abrio, false);
  });
});

test('el plazo vence sin código y la cámara queda cerrada', async () => {
  let cierres = 0;
  const lector = crearLectorQr(puerto({
    esperarCodigo: () => new Promise(() => undefined),
    cerrarCamara: () => { cierres += 1; },
  }));

  await assert.rejects(lector.escanear(5), (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'timeout' && e.reintentable);
  assert.equal(cierres, 1);
});

test('cancelar cierra la cámara y termina el escaneo, no lo deja colgado', async () => {
  let rechazarLectura: ((error: Error) => void) | undefined;
  let cierres = 0;
  const lector = crearLectorQr(puerto({
    esperarCodigo: () => new Promise((_, rechazar) => { rechazarLectura = rechazar; }),
    cerrarCamara: () => {
      cierres += 1;
      rechazarLectura?.(new Error('camara-cerrada'));
    },
  }));

  const lectura = lector.escanear(10_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  lector.cancelar();

  await assert.rejects(lectura, (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'cancelado');
  // Una vez al cancelar y otra en el finally: cerrar de más no cuesta nada,
  // quedarse con la cámara encima de la ronda sí.
  assert.ok(cierres >= 1);
});

test('un segundo escaneo simultáneo no roba la cámara del primero', async () => {
  let resolver: ((codigo: string) => void) | undefined;
  const lector = crearLectorQr(puerto({
    esperarCodigo: () => new Promise((resolve) => { resolver = resolve; }),
  }));

  const primero = lector.escanear(1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(lector.escanear(1_000), (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'camara-ocupada' && e.reintentable);
  resolver?.(CODIGO);
  await primero;
});

test('un fallo de la cámara no se filtra crudo al portal', async () => {
  const lector = crearLectorQr(puerto({
    abrirCamara: () => { throw new Error('CameraView: native module not available'); },
  }));

  await assert.rejects(lector.escanear(100), (e: unknown) =>
    e instanceof ErrorEscaneo && e.codigo === 'error-desconocido' &&
    !/native module/.test(e.message));
});
