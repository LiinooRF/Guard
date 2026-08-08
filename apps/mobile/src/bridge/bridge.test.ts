import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebViewMessageEvent } from 'react-native-webview';

import { crearPuenteNativo, type ManejadoresNativos } from './native';
import {
  armarSobre,
  leerMensajePortal,
  leerMensajeShell,
  verificarCompatibilidad,
  type MensajePortal,
} from './protocol';

const ORIGEN = 'https://control.example.test';

function evento(mensaje: MensajePortal, url = `${ORIGEN}/app/guardia`) {
  return { nativeEvent: { data: JSON.stringify(mensaje), url } } as WebViewMessageEvent;
}

function esperarMensajes() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CODIGO_QR = 'VXQ-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function setup() {
  const inyectados: string[] = [];
  let escaneos = 0;
  let escaneosQr = 0;
  let cancelacionesQr = 0;
  const operaciones = new Set<string>();
  const manejadores: ManejadoresNativos = {
    capacidades: async () => ({
      tieneNfc: true, nfcActivado: true, tieneCamara: true, nivelApiAndroid: 35,
    }),
    escanearNfc: async () => {
      escaneos += 1;
      return {
        uid: '04AABBCCDD', tech: 'nfc', scannedAt: new Date().toISOString(),
        clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
        deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
        signature: 'a'.repeat(64),
      };
    },
    cancelarEscaneo: () => undefined,
    escanearQr: async () => {
      escaneosQr += 1;
      return {
        uid: CODIGO_QR, tech: 'qr', scannedAt: new Date().toISOString(),
        clientScanId: '5a0c8f7e-1111-4222-8333-444455556666',
        deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
        signature: 'c'.repeat(64),
      };
    },
    cancelarEscaneoQr: () => { cancelacionesQr += 1; },
    pedirPermiso: async (permiso) => ({
      permiso, estado: 'concedido', puedeVolverAPedir: true,
    }),
    consultarPermiso: async (permiso) => ({
      permiso, estado: 'concedido', puedeVolverAPedir: true,
    }),
    estadoConexion: async () => ({ enLinea: true, tipo: 'wifi' }),
    guardarRutaOffline: async () => new Date().toISOString(),
    borrarRutaOffline: async () => undefined,
    encolarSync: async ({ operation }) => {
      const inserted = !operaciones.has(operation.clientId);
      operaciones.add(operation.clientId);
      return inserted;
    },
    sincronizarCola: async () => ({ procesadas: 0, pendientes: 0 }),
    registrarFirma: async () => '4a0c8f7e-1111-4222-8333-444455556666',
  };
  const puente = crearPuenteNativo({
    portalOrigen: ORIGEN,
    appVersion: '0.1.0',
    inyectar: (script) => inyectados.push(script),
    manejadores,
    alIncompatible: () => undefined,
  });
  return {
    puente,
    inyectados,
    escaneos: () => escaneos,
    escaneosQr: () => escaneosQr,
    cancelacionesQr: () => cancelacionesQr,
    operaciones,
  };
}

test('abrir la app no arma ningún temporizador que pueda bloquearla', () => {
  /*
   * La regresión que fija esta prueba tumbaba el producto entero: el shell
   * armaba una espera de 10 s por el saludo del portal y, como el portal solo
   * saluda desde `useGuardBridge` —que se monta DESPUÉS del login—, la app se
   * declaraba "Portal incompatible" sola, con el guardia todavía escribiendo su
   * clave. Nadie podía iniciar sesión.
   *
   * Se comprueba contando temporizadores en vez de esperando 10 segundos: la
   * prueba tiene que fallar al reintroducir el bug, no tardar.
   */
  const real = globalThis.setTimeout;
  const armados: number[] = [];
  (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number) => {
    armados.push(ms ?? 0);
    return real(fn, ms);
  };
  try {
    setup();
  } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = real;
  }
  assert.deepEqual(armados, []);
});

test('rechaza payloads mal formados antes de llegar a los módulos nativos', () => {
  const crudo = JSON.stringify({
    ...armarSobre('nfc.scan.start', { timeoutMs: 'sin-limite' }),
  });
  assert.deepEqual(leerMensajePortal(crudo), {
    ok: false, codigo: 'mensaje-invalido', detalle: 'payload nfc.scan.start',
  });
  const scanFalso = JSON.stringify(armarSobre('nfc.scan.result', {
    uid: 'uid-minuscula', tech: 'nfc', scannedAt: 'ayer',
  }));
  assert.equal(leerMensajeShell(scanFalso).ok, false);
  const firmaFalsa = JSON.stringify(armarSobre('nfc.scan.result', {
    uid: '04AABBCC', tech: 'nfc', scannedAt: '2026-08-04T01:00:00.000Z',
    clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
    deviceId: '4a0c8f7e-1111-4222-8333-444455556666',
    signature: 'no-es-una-firma',
  }));
  assert.equal(leerMensajeShell(firmaFalsa).ok, false);
});

test('rechaza mensajes de iframes u orígenes diferentes', async () => {
  const { puente, escaneos } = setup();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
    'https://evil.example/iframe',
  ));
  puente.alRecibirMensaje(evento(
    armarSobre('nfc.scan.start', { timeoutMs: 10_000 }),
    'https://evil.example/iframe',
  ));
  await esperarMensajes();
  assert.equal(escaneos(), 0);
  puente.detener();
});

test('no atiende comandos antes del saludo ready', async () => {
  const { puente, escaneos, inyectados } = setup();
  puente.alRecibirMensaje(evento(armarSobre('nfc.scan.start', { timeoutMs: 10_000 })));
  puente.notificarConexion({ enLinea: false, tipo: 'ninguna' });
  await esperarMensajes();
  assert.equal(escaneos(), 0);
  assert.equal(inyectados.length, 0);
  puente.detener();
});

test('saluda y entrega un escaneo correlacionado en menos de 300 ms', async () => {
  const { puente, inyectados, escaneos } = setup();
  const inicio = Date.now();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
  ));
  await esperarMensajes();
  puente.alRecibirMensaje(evento(armarSobre('nfc.scan.start', { timeoutMs: 10_000 })));
  await esperarMensajes();

  assert.equal(escaneos(), 1);
  assert.match(inyectados[0] ?? '', /ready/);
  assert.match(inyectados[1] ?? '', /nfc\\\.scan\\\.result|nfc\.scan\.result/);
  assert.ok(Date.now() - inicio < 300);
  puente.detener();
});

test('el respaldo por QR responde por su propio canal y llega marcado como qr', async () => {
  const { puente, inyectados, escaneos, escaneosQr } = setup();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
  ));
  await esperarMensajes();
  puente.alRecibirMensaje(evento(armarSobre('qr.scan.start', { timeoutMs: 10_000 })));
  await esperarMensajes();

  assert.equal(escaneosQr(), 1);
  // El lector NFC no se toca: son dos recursos distintos del teléfono.
  assert.equal(escaneos(), 0);
  const respuesta = inyectados[1] ?? '';
  assert.match(respuesta, /qr\\?\.scan\\?\.result/);
  assert.match(respuesta, /VXQ-/);
  // Si esto dijera 'nfc', un código fotografiado valdría lo mismo que la
  // etiqueta pegada y el informe no podría distinguirlos.
  assert.doesNotMatch(respuesta, /nfc\\?\.scan\\?\.result/);
  puente.detener();
});

test('cancelar el QR llega al manejador que apaga la cámara', async () => {
  const { puente, cancelacionesQr } = setup();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
  ));
  await esperarMensajes();
  puente.alRecibirMensaje(evento(armarSobre('qr.scan.cancel', {})));
  await esperarMensajes();

  assert.equal(cancelacionesQr(), 1);
  puente.detener();
});

test('los dos escaneos no se cruzan de formato: cada uid tiene su patrón', () => {
  // Un uid de etiqueta NFC no pasa por el canal del QR...
  assert.equal(
    leerMensajeShell(JSON.stringify(armarSobre('qr.scan.result', {
      uid: '04AABBCCDD', tech: 'qr', scannedAt: '2026-08-05T01:00:00.000Z',
    }))).ok,
    false,
  );
  // ...ni el código impreso pasa por el del NFC.
  assert.equal(
    leerMensajeShell(JSON.stringify(armarSobre('nfc.scan.result', {
      uid: CODIGO_QR, tech: 'nfc', scannedAt: '2026-08-05T01:00:00.000Z',
    }))).ok,
    false,
  );
  // El QR de un afiche cualquiera tampoco: el shell filtra antes de responder,
  // pero el contrato no confía en eso.
  assert.equal(
    leerMensajeShell(JSON.stringify(armarSobre('qr.scan.result', {
      uid: 'https://promo.example.cl', tech: 'qr', scannedAt: '2026-08-05T01:00:00.000Z',
    }))).ok,
    false,
  );
  assert.equal(
    leerMensajeShell(JSON.stringify(armarSobre('qr.scan.result', {
      uid: CODIGO_QR, tech: 'qr', scannedAt: '2026-08-05T01:00:00.000Z',
    }))).ok,
    true,
  );
});

test('agregar los mensajes qr.* es aditivo: un portal del minor 0 sigue entrando', () => {
  // La ventana de gracia es lo único que impide que una app publicada en Play
  // deje de escanear por un deploy del portal. Si esto se rompe, el guardia se
  // queda sin ronda y NO se arregla con un deploy.
  assert.equal(verificarCompatibilidad({ major: 1, minMinor: 0 }).ok, true);
  assert.equal(verificarCompatibilidad({ major: 1, minMinor: 4 }).ok, true);
  const futuro = verificarCompatibilidad({ major: 1, minMinor: 5 });
  assert.equal(futuro.ok ? undefined : futuro.motivo, 'app-antigua');
});

test('clasifica app antigua y portal antiguo sin confundir la solución', () => {
  const appAntigua = verificarCompatibilidad({ major: 2, minMinor: 0 });
  const portalAntiguo = verificarCompatibilidad({ major: 0, minMinor: 0 });
  assert.equal(appAntigua.ok ? undefined : appAntigua.motivo, 'app-antigua');
  assert.equal(portalAntiguo.ok ? undefined : portalAntiguo.motivo, 'portal-antiguo');
  assert.equal(verificarCompatibilidad({ major: 1, minMinor: 0 }).ok, true);
});

test('valida y persiste la ruta offline solo después del saludo', async () => {
  const { puente, inyectados } = setup();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
  ));
  await esperarMensajes();
  puente.alRecibirMensaje(evento(armarSobre('offline.route.save', {
    patrolId: '3a0c8f7e-1111-4222-8333-444455556666',
    status: 'en_curso' as const,
    siteName: 'Recinto Norte',
    routeName: 'Perímetro',
    scheduledStartAt: '2026-08-04T01:00:00.000Z',
    scheduledEndAt: '2026-08-04T09:00:00.000Z',
    estimatedDurationMin: 45,
    checkpoints: [{ id: 'punto-1', name: 'Acceso norte', position: 1, tagUids: ['04AABBCC'] }],
  })));
  await esperarMensajes();

  assert.match(inyectados[1] ?? '', /offline\.route\.saved|offline.route.saved/);
  puente.detener();
});

test('rechaza una ruta offline vacía o de tamaño operativo absurdo', () => {
  const mensaje = armarSobre('offline.route.save', {
    patrolId: 'patrol-1',
    status: 'en_curso',
    siteName: 'Recinto',
    routeName: 'Ruta',
    scheduledStartAt: '2026-08-04T01:00:00.000Z',
    scheduledEndAt: '2026-08-04T09:00:00.000Z',
    estimatedDurationMin: 45,
    checkpoints: [],
  });
  assert.equal(leerMensajePortal(JSON.stringify(mensaje)).ok, false);
});

test('la cola nativa conserva un solo UUID aunque el portal lo envíe tres veces', async () => {
  const { puente, operaciones, inyectados } = setup();
  puente.alRecibirMensaje(evento(
    armarSobre('hello', { portalBuild: 'test', requiere: { major: 1, minMinor: 0 } }),
  ));
  await esperarMensajes();
  const payload = {
    apiUrl: 'https://api.example.test',
    portalOrigin: 'https://control.example.test',
    operation: {
      type: 'scan' as const,
      clientId: '3a0c8f7e-1111-4222-8333-444455556666',
      patrolId: '4a0c8f7e-1111-4222-8333-444455556666',
      payload: {
        uid: '04AABBCC',
        method: 'nfc',
        clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
      },
      queuedAt: '2026-08-04T01:00:00.000Z',
    },
  };
  for (let intento = 0; intento < 3; intento += 1) {
    puente.alRecibirMensaje(evento(armarSobre('sync.queue.enqueue', payload)));
    await esperarMensajes();
  }

  assert.equal(operaciones.size, 1);
  assert.match(inyectados.at(-1) ?? '', /sync\.queue\.enqueued|sync.queue.enqueued/);
  puente.detener();
});

test('la cola rechaza API HTTP externa y claves que no sean UUID', () => {
  const invalido = armarSobre('sync.queue.enqueue', {
    apiUrl: 'http://api.example.test',
    portalOrigin: 'https://control.example.test',
    operation: {
      type: 'scan', clientId: 'predecible', patrolId: 'tambien', payload: {},
      queuedAt: '2026-08-04T01:00:00.000Z',
    },
  });
  assert.equal(leerMensajePortal(JSON.stringify(invalido)).ok, false);
});
