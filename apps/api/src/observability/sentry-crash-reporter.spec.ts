import type { CrashEvent } from './crash-event';
import { parseSentryDsn, type CrashReportingConfig } from './crash-reporting.config';
import {
  NoopCrashReporter,
  SentryCrashReporter,
  crearCrashReporter,
  type EnvioHttp,
} from './sentry-crash-reporter';

const DSN = parseSentryDsn('https://laclave@sentry.local/42');

function evento(): CrashEvent {
  return {
    eventId: 'b'.repeat(32),
    level: 'error',
    occurredAt: new Date('2026-08-03T12:00:00.000Z'),
    release: 'sentrycore-api@1.0.0',
    environment: 'staging',
    errorName: 'QueryFailedError',
    errorMessage: 'la columna no existe',
    stack: ['at query (/app/dist/db.js:1:1)'],
    fingerprint: 'abcdef0123456789',
    tags: { source: 'api' },
    requestId: null,
  };
}

function reporter(envio: EnvioHttp, ahora: () => number = Date.now) {
  // 20 ms de tope: el temporizador de AbortSignal no debe sobrevivir al test.
  return new SentryCrashReporter(DSN, 20, envio, ahora);
}

describe('SentryCrashReporter', () => {
  it('manda el sobre al endpoint de envelopes con la cabecera de autenticacion', async () => {
    const envio = jest.fn<ReturnType<EnvioHttp>, Parameters<EnvioHttp>>(async () => ({
      status: 200,
    }));

    await expect(reporter(envio).send(evento())).resolves.toBe(true);

    const [url, init] = envio.mock.calls[0] ?? [];
    expect(url).toBe('https://sentry.local/api/42/envelope/');
    expect(init?.method).toBe('POST');
    expect(init?.headers['x-sentry-auth']).toContain('sentry_key=laclave');
    expect(init?.body.split('\n')).toHaveLength(4); // tres lineas + salto final
  });

  it.each([400, 401, 429, 500])('un %d no es exito y no lanza', async (status) => {
    const envio = jest.fn<ReturnType<EnvioHttp>, Parameters<EnvioHttp>>(async () => ({ status }));

    await expect(reporter(envio).send(evento())).resolves.toBe(false);
  });

  it('la red caida no se propaga: la API responde igual', async () => {
    const envio: EnvioHttp = () => Promise.reject(new Error('ECONNREFUSED'));

    await expect(reporter(envio).send(evento())).resolves.toBe(false);
  });

  it('tras cinco fallos seguidos deja de intentar por un rato', async () => {
    const envio = jest.fn<ReturnType<EnvioHttp>, Parameters<EnvioHttp>>(async () => ({
      status: 503,
    }));
    let reloj = 1_000;
    const sujeto = reporter(envio, () => reloj);

    for (let intento = 0; intento < 5; intento += 1) await sujeto.send(evento());
    expect(envio).toHaveBeenCalledTimes(5);

    // Sexto intento: el cortacircuito esta abierto y no toca la red.
    await expect(sujeto.send(evento())).resolves.toBe(false);
    expect(envio).toHaveBeenCalledTimes(5);

    // Pasados los cinco minutos vuelve a intentar.
    reloj += 5 * 60 * 1_000 + 1;
    await sujeto.send(evento());
    expect(envio).toHaveBeenCalledTimes(6);
  });

  it('un exito reinicia la cuenta de fallos', async () => {
    let status = 500;
    const envio = jest.fn<ReturnType<EnvioHttp>, Parameters<EnvioHttp>>(async () => ({ status }));
    const sujeto = reporter(envio, () => 1_000);

    for (let intento = 0; intento < 4; intento += 1) await sujeto.send(evento());
    status = 200;
    await expect(sujeto.send(evento())).resolves.toBe(true);

    status = 500;
    for (let intento = 0; intento < 4; intento += 1) await sujeto.send(evento());
    expect(envio).toHaveBeenCalledTimes(9);
  });

  it('descarta un evento gigante en vez de mandarlo', async () => {
    const envio = jest.fn<ReturnType<EnvioHttp>, Parameters<EnvioHttp>>(async () => ({
      status: 200,
    }));
    const gigante: CrashEvent = {
      ...evento(),
      stack: Array.from({ length: 40 }, () => 'x'.repeat(9_000)),
    };

    await expect(reporter(envio).send(gigante)).resolves.toBe(false);
    expect(envio).not.toHaveBeenCalled();
  });
});

describe('crearCrashReporter', () => {
  const base: CrashReportingConfig = {
    driver: 'off',
    dsn: null,
    environment: 'test',
    release: 'sentrycore-api@test',
    timeoutMs: 20,
    maxPerUserHour: 20,
  };

  it('con el driver apagado devuelve el transporte que no manda nada', () => {
    const sinEnviar = crearCrashReporter(base);

    expect(sinEnviar).toBeInstanceOf(NoopCrashReporter);
    expect(sinEnviar.enabled).toBe(false);
  });

  it('con driver sentry pero sin DSN tampoco manda: no adivina', () => {
    expect(crearCrashReporter({ ...base, driver: 'sentry' })).toBeInstanceOf(NoopCrashReporter);
  });

  it('con driver sentry y DSN devuelve el transporte real', () => {
    const activo = crearCrashReporter({ ...base, driver: 'sentry', dsn: DSN });

    expect(activo).toBeInstanceOf(SentryCrashReporter);
    expect(activo.enabled).toBe(true);
  });
});
