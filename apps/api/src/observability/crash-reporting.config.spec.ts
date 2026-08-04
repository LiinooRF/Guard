import { loadCrashReportingConfig, parseSentryDsn } from './crash-reporting.config';

describe('parseSentryDsn', () => {
  it('descompone el DSN del servicio publico', () => {
    const dsn = parseSentryDsn('https://abc123def456@o987654.ingest.sentry.io/4508');

    expect(dsn.publicKey).toBe('abc123def456');
    expect(dsn.projectId).toBe('4508');
    expect(dsn.envelopeUrl).toBe('https://o987654.ingest.sentry.io/api/4508/envelope/');
  });

  it('respeta el prefijo de ruta de una instalacion propia', () => {
    const dsn = parseSentryDsn('https://clave@sentry.midominio.cl/errores/7');

    expect(dsn.envelopeUrl).toBe('https://sentry.midominio.cl/errores/api/7/envelope/');
  });

  it.each([
    ['no-es-una-url', 'no es una URL valida'],
    ['ftp://clave@host/1', 'debe usar http o https'],
    ['https://host/4508', 'clave publica'],
    ['https://clave@host/no-numerico', 'id de proyecto numerico'],
  ])('rechaza %s', (dsn, esperado) => {
    expect(() => parseSentryDsn(dsn)).toThrow(esperado);
  });

  it('el mensaje de error NUNCA repite el DSN: termina en el log de arranque', () => {
    try {
      parseSentryDsn('https://clave-super-secreta@host/abc');
      throw new Error('deberia haber lanzado');
    } catch (error) {
      expect((error as Error).message).not.toContain('clave-super-secreta');
    }
  });
});

describe('loadCrashReportingConfig', () => {
  it('sin configurar nada queda apagado y NO impide arrancar', () => {
    const config = loadCrashReportingConfig({});

    expect(config.driver).toBe('off');
    expect(config.dsn).toBeNull();
  });

  it('el driver sentry sin DSN falla al arrancar, no en el primer error', () => {
    expect(() => loadCrashReportingConfig({ CRASH_REPORT_DRIVER: 'sentry' })).toThrow(
      'requiere SENTRY_DSN',
    );
  });

  it('en produccion exige un release de verdad', () => {
    expect(() =>
      loadCrashReportingConfig({
        NODE_ENV: 'production',
        CRASH_REPORT_DRIVER: 'sentry',
        SENTRY_DSN: 'https://clave@host/1',
      }),
    ).toThrow('SENTRY_RELEASE real');
  });

  it('el ambiente cae al NODE_ENV cuando no se declara', () => {
    expect(loadCrashReportingConfig({ NODE_ENV: 'staging' }).environment).toBe('staging');
    expect(
      loadCrashReportingConfig({ NODE_ENV: 'staging', SENTRY_ENVIRONMENT: 'qa' }).environment,
    ).toBe('qa');
  });

  it('convierte los numeros del entorno, que siempre llegan como texto', () => {
    const config = loadCrashReportingConfig({
      CRASH_REPORT_TIMEOUT_MS: '1500',
      CRASH_REPORT_MAX_PER_USER_HOUR: '5',
    });

    expect(config.timeoutMs).toBe(1_500);
    expect(config.maxPerUserHour).toBe(5);
  });

  it('rechaza un limite absurdo en vez de aceptarlo en silencio', () => {
    expect(() => loadCrashReportingConfig({ CRASH_REPORT_TIMEOUT_MS: '999999' })).toThrow(
      'Configuracion de crash reporting invalida',
    );
  });
});
