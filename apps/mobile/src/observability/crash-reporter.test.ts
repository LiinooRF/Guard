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

test('sanitizarTexto redacta las cookies REALES del producto, no solo connect.sid (#321)', () => {
  // El refresh es randomBytes(48).toString('base64url'): no es un JWT, asi
  // que ningun otro patron lo toca si no esta explicito.
  const refresh = 'kQ3f9j_2mZ-abcDEF012345_-xyzKLMN678opqRSTU-9012vwYZ34';
  const texto = `Cookie: sentrycore_access=eyJhbGciOi.eyJzdWIi.signature; sentrycore_refresh=${refresh}`;
  const limpio = sanitizarTexto(texto);

  assert.ok(!limpio.includes(refresh));
  assert.ok(limpio.includes('sentrycore_refresh=[REDACTED]'));
  // El access token es JWT: cae en PATRON_JWT antes de llegar a PATRON_COOKIE.
  assert.ok(!limpio.includes('eyJhbGciOi.eyJzdWIi.signature'));
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

test('instalarReportadorGlobal registra el manejador respetando el handler previo (no fatal)', async () => {
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

  // Mockeado y esperado a propósito: el camino no-fatal dispara
  // reportarCaida() como fire-and-forget (`void`), y sin mock hace un fetch
  // REAL a 'http://api.local' que sigue vivo de fondo después de que el test
  // termina — y termina escribiendo en la cola de OTRO test que corre
  // después (así se descubrió el hallazgo de #321: dos entradas donde se
  // esperaba una).
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ received: true }), { status: 201 })) as typeof fetch;

  try {
    instalarReportadorGlobal(() => 'http://api.local');

    assert.ok(handlerInstalado);
    handlerInstalado(new Error('Test unhandled'), false);
    assert.equal(handlerPrevioLlamado, true);

    // Deja que el reportarCaida() fire-and-forget termine antes de restaurar
    // fetch y de que el siguiente test arranque.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('instalarReportadorGlobal ante un error FATAL encola antes de ceder el proceso al handler previo (#321)', async () => {
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

  // Simula que ni siquiera hay red: lo que importa es que la caida haya
  // quedado en la cola ANTES de que se ceda el proceso, sin importar si el
  // envio inmediato tuvo suerte.
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('sin red');
  }) as typeof fetch;

  try {
    instalarReportadorGlobal(() => 'http://api.local');
    assert.ok(handlerInstalado);

    handlerInstalado(new Error('Fatal en el escaneo'), true);

    // El proceso NO se cede en el mismo tick: si esto fuera sincronico (como
    // antes), un handlerPrevio real de React Native mataria el proceso antes
    // de que la escritura en cola llegue a completarse, y la caida fatal se
    // perderia sin dejar rastro.
    assert.equal(handlerPrevioLlamado, false);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(handlerPrevioLlamado, true);

    const encoladasStr = storeMock.get('sentrycore.crash_queue.v1');
    assert.ok(encoladasStr);
    const encoladas = JSON.parse(encoladasStr);
    assert.equal(encoladas.length, 1);
    assert.equal(encoladas[0].errorMessage, 'Fatal en el escaneo');
    assert.equal(encoladas[0].fatal, true);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
