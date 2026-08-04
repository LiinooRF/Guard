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

function setup() {
  const inyectados: string[] = [];
  let escaneos = 0;
  const manejadores: ManejadoresNativos = {
    capacidades: async () => ({
      tieneNfc: true, nfcActivado: true, tieneCamara: true, nivelApiAndroid: 35,
    }),
    escanearNfc: async () => {
      escaneos += 1;
      return { uid: '04AABBCCDD', tech: 'nfc', scannedAt: new Date().toISOString() };
    },
    cancelarEscaneo: () => undefined,
    pedirPermiso: async (permiso) => ({
      permiso, estado: 'concedido', puedeVolverAPedir: true,
    }),
    consultarPermiso: async (permiso) => ({
      permiso, estado: 'concedido', puedeVolverAPedir: true,
    }),
    estadoConexion: async () => ({ enLinea: true, tipo: 'wifi' }),
    guardarRutaOffline: async () => new Date().toISOString(),
    borrarRutaOffline: async () => undefined,
  };
  const puente = crearPuenteNativo({
    portalOrigen: ORIGEN,
    appVersion: '0.1.0',
    inyectar: (script) => inyectados.push(script),
    manejadores,
    alIncompatible: () => undefined,
    msEsperaSaludo: 60_000,
  });
  return { puente, inyectados, escaneos: () => escaneos };
}

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
