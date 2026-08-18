import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  formatearErrorParaReporte,
  instalarReportadorGlobal,
  reportarCaida,
  setStorageAdapter,
  vaciarColaDeCaidas,
  type StorageAdapter,
} from './crash-reporter';
import { sanitizarTexto } from './scrubber';

const storeMock = new Map<string, string>();
const fakeStorage: StorageAdapter = {
  getItemAsync: async (k: string) => storeMock.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    storeMock.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    storeMock.delete(k);
  },
};

setStorageAdapter(fakeStorage);

beforeEach(() => {
  storeMock.clear();
});

test('sanitizarTexto elimina correos, tokens Bearer, JWT y cookies sensibles', () => {
  const texto =
    'Error at guard@sentrycore.com with Authorization: Bearer secret_token_123 and cookie connect.sid=s%3A123 and jwt eyJhbGciOi.eyJzdWIi.signature';
  const limpio = sanitizarTexto(texto);

  assert.ok(!limpio.includes('guard@sentrycore.com'));
  assert.ok(!limpio.includes('secret_token_123'));
  assert.ok(!limpio.includes('connect.sid=s%3A123'));
  assert.ok(limpio.includes('[EMAIL_REDACTED]'));
  assert.ok(limpio.includes('Bearer [REDACTED]'));
  assert.ok(limpio.includes('connect.sid=[REDACTED]'));
  assert.ok(limpio.includes('[JWT_REDACTED]'));
});

test('formatearErrorParaReporte genera payload conforme al contrato de ReportCrashDto', () => {
  const error = new TypeError('Cannot read properties of undefined (reading scan)');
  const payload = formatearErrorParaReporte(error, { fatal: true });

  assert.equal(payload.errorName, 'TypeError');
  assert.equal(payload.errorMessage, 'Cannot read properties of undefined (reading scan)');
  assert.equal(payload.fatal, true);
  assert.ok(payload.appVersion.length >= 1 && payload.appVersion.length <= 32);
  assert.ok(payload.deviceModel.length >= 1 && payload.deviceModel.length <= 64);
  assert.ok(payload.androidVersion.length >= 1 && payload.androidVersion.length <= 32);
  assert.equal(typeof payload.bridgeProtocolVersion, 'number');
  assert.ok(payload.occurredAt && !isNaN(Date.parse(payload.occurredAt)));
});

test('formatearErrorParaReporte maneja errores que son strings u objetos sin fallar', () => {
  const payloadStr = formatearErrorParaReporte('Fallo en sincronización');
  assert.equal(payloadStr.errorName, 'Error');
  assert.equal(payloadStr.errorMessage, 'Fallo en sincronización');

  const payloadObj = formatearErrorParaReporte({ codigo: 500, detalle: 'timeout' });
  assert.equal(payloadObj.errorName, 'Error');
  assert.ok(payloadObj.errorMessage.includes('timeout'));
});

test('formatearErrorParaReporte respeta topes de longitud máximos del backend', () => {
  const errorLargo = new Error('A'.repeat(5_000));
  errorLargo.name = 'B'.repeat(200);
  const payload = formatearErrorParaReporte(errorLargo, { stackManual: 'C'.repeat(50_000) });

  assert.ok(payload.errorName.length <= 120);
  assert.ok(payload.errorMessage.length <= 4_000);
  assert.ok((payload.stack?.length ?? 0) <= 40_000);
});

test('reportarCaida sin apiUrl encola la caída para reintento offline', async () => {
  const error = new Error('Caída en subterráneo sin señal');
  await reportarCaida(error, { fatal: false });

  const encoladasStr = storeMock.get('sentrycore.crash_queue.v1');
  assert.ok(encoladasStr);
  const encoladas = JSON.parse(encoladasStr);
  assert.equal(encoladas.length, 1);
  assert.equal(encoladas[0].errorMessage, 'Caída en subterráneo sin señal');
});

test('vaciarColaDeCaidas despacha los reportes pendientes cuando hay apiUrl', async () => {
  storeMock.set(
    'sentrycore.crash_queue.v1',
    JSON.stringify([
      {
        errorName: 'ErrorOffline',
        errorMessage: 'Error guardado sin señal',
        appVersion: '0.1.0',
        deviceModel: 'Android',
        androidVersion: '13',
        fatal: false,
      },
    ]),
  );

  const llamadas: unknown[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ received: true }), { status: 201 });
  }) as typeof fetch;

  try {
    await vaciarColaDeCaidas('http://api.local');
    assert.equal(llamadas.length, 1);
    assert.equal(
      (llamadas[0] as { url: string }).url,
      'http://api.local/crash-reports',
    );
    // Cola vaciada y eliminada
    assert.equal(storeMock.get('sentrycore.crash_queue.v1'), undefined);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('instalarReportadorGlobal registra el manejador respetando el handler previo', () => {
  let handlerPrevioLlamado = false;
  const handlerPrevio = () => {
    handlerPrevioLlamado = true;
  };

  let handlerInstalado: ((error: Error, isFatal?: boolean) => void) | undefined;

  const globalAny = global as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
    };
  };

  globalAny.ErrorUtils = {
    getGlobalHandler: () => handlerPrevio,
    setGlobalHandler: (h) => {
      handlerInstalado = h;
    },
  };

  instalarReportadorGlobal(() => 'http://api.local');

  assert.ok(handlerInstalado);
  handlerInstalado(new Error('Test unhandled'), true);
  assert.equal(handlerPrevioLlamado, true);
});
