import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PATROL_RULES } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { CrashEvent, CrashReporter } from './crash-event';
import type { CrashReportingConfig } from './crash-reporting.config';
import {
  CrashReportingService,
  RETENCION_CAIDAS_DIAS_DEFECTO,
  retencionDeCaidas,
} from './crash-reporting.service';
import type { ReportCrashDto } from './dto/report-crash.dto';

const TENANT = '3f0d8a1c-1111-4222-8333-444455556666';
const USUARIO = '11111111-2222-4333-8444-555566667777';
const ID_REPORTE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000';

const CONFIG: CrashReportingConfig = {
  driver: 'sentry',
  dsn: { publicKey: 'k', projectId: '1', envelopeUrl: 'https://sentry.local/api/1/envelope/' },
  environment: 'staging',
  release: 'voxia-api@1.0.0',
  timeoutMs: 20,
  maxPerUserHour: 20,
};

function caida(cambios: Partial<ReportCrashDto> = {}): ReportCrashDto {
  return {
    errorName: 'NfcBridgeError',
    errorMessage: 'no se pudo leer la etiqueta',
    stack: 'at leerTag (app://bundle.js:120:9)',
    appVersion: '1.4.2',
    deviceModel: 'Redmi 9A',
    androidVersion: '10',
    ...cambios,
  };
}

/**
 * Respuestas del driver de Postgres, en la forma REAL de cada sentencia:
 *
 *   SELECT / INSERT ... RETURNING  ->  arreglo plano de filas
 *   UPDATE / DELETE                ->  [filas, rowCount]
 *
 * Devolver `[{...}]` para un UPDATE, que es lo comodo, deja el test verde y la
 * respuesta rota. Aca se devuelve lo que devuelve Postgres.
 */
function crearEntorno(opciones: { total?: string; borradas?: number; actualizadas?: number } = {}) {
  const query: jest.Mock = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT count(*) AS total')) return [{ total: opciones.total ?? '0' }];
    if (sql.trimStart().startsWith('DELETE')) return [[], opciones.borradas ?? 0];
    if (sql.trimStart().startsWith('UPDATE')) return [[], opciones.actualizadas ?? 1];
    if (sql.includes('INSERT INTO app_crash_reports')) return [{ id: ID_REPORTE }];
    return [];
  });

  const reporter: CrashReporter = { enabled: true, send: jest.fn(async () => true) };
  const tenantContext = { manager: { query } } as unknown as TenantContextService;
  const rules = { effective: jest.fn(async () => DEFAULT_PATROL_RULES) } as unknown as RulesService;

  return {
    query,
    reporter,
    servicio: new CrashReportingService(tenantContext, rules, reporter, CONFIG),
  };
}

/** El SQL de la sentencia que empieza con `inicio`, tal como se ejecuto. */
function sqlDe(query: jest.Mock, inicio: string): string {
  const llamada = query.mock.calls.find(([sql]) => String(sql).trimStart().startsWith(inicio));
  return String(llamada?.[0] ?? '');
}

function parametrosDe(query: jest.Mock, inicio: string): unknown[] {
  const llamada = query.mock.calls.find(([sql]) => String(sql).trimStart().startsWith(inicio));
  return (llamada?.[1] as unknown[]) ?? [];
}

describe('retencionDeCaidas', () => {
  it('usa el default del producto mientras la regla no exista en rules.ts', () => {
    expect(retencionDeCaidas(DEFAULT_PATROL_RULES)).toBe(RETENCION_CAIDAS_DIAS_DEFECTO);
  });

  it('cuando la regla exista, manda el valor de la cascada', () => {
    const conRegla = { ...DEFAULT_PATROL_RULES, crashReportRetentionDays: 90 };

    expect(retencionDeCaidas(conRegla)).toBe(90);
  });

  it('un valor fuera de rango vuelve al default en vez de romper la operacion', () => {
    const roto = { ...DEFAULT_PATROL_RULES, crashReportRetentionDays: 5_000 };

    expect(retencionDeCaidas(roto)).toBe(RETENCION_CAIDAS_DIAS_DEFECTO);
  });
});

describe('registrarCaidaDeApp', () => {
  it('guarda la caida y la manda al proveedor', async () => {
    const { servicio, query, reporter } = crearEntorno();

    await expect(servicio.registrarCaidaDeApp(USUARIO, TENANT, caida())).resolves.toEqual({
      registrado: true,
      enviado: true,
    });

    const parametros = parametrosDe(query, 'INSERT');
    expect(parametros[0]).toBe(USUARIO);
    expect(parametros[2]).toBe('1.4.2');
    expect(parametros[3]).toBe('Redmi 9A');
    expect(parametros[4]).toBe('10');
    expect(reporter.send).toHaveBeenCalledTimes(1);
  });

  it('la version, el modelo y la version de Android viajan en el evento', async () => {
    const { servicio, reporter } = crearEntorno();

    await servicio.registrarCaidaDeApp(USUARIO, TENANT, caida());

    const evento = (reporter.send as jest.Mock).mock.calls[0]?.[0] as CrashEvent;
    expect(evento.tags).toMatchObject({
      source: 'app',
      tenant_id: TENANT,
      app_version: '1.4.2',
      device_model: 'Redmi 9A',
      android_version: '10',
      fatal: 'true',
    });
    // El release apunta a la version de la APP: el stacktrace que hay que
    // mapear es el del telefono, no el de la API.
    expect(evento.release).toBe('voxia-app@1.4.2');
  });

  it('el mensaje y la pila salen enmascarados hacia la base y hacia el proveedor', async () => {
    const { servicio, query, reporter } = crearEntorno();

    await servicio.registrarCaidaDeApp(
      USUARIO,
      TENANT,
      caida({
        errorMessage: 'fallo con jperez@empresa.cl en -33.44890,-70.66930',
        stack: 'at sync (/home/jperez/app/sync.js:10:5)',
      }),
    );

    // [7] es error_message y [8] es stack, en el orden del INSERT.
    const parametros = parametrosDe(query, 'INSERT');
    expect(String(parametros[7])).not.toContain('jperez@empresa.cl');
    expect(String(parametros[7])).not.toContain('-33.44890');
    expect(String(parametros[8])).not.toContain('jperez');

    const evento = (reporter.send as jest.Mock).mock.calls[0]?.[0] as CrashEvent;
    expect(evento.errorMessage).not.toContain('jperez');
  });

  /**
   * Los tres casos de abajo prueban LOS CHECK DE LA MIGRACION, no el gusto de
   * nadie. Los limites salen de 1725559200000-CreateAppCrashReports.ts:
   *
   *   error_message   length BETWEEN 1 AND 2000
   *   stack           length <= 20000
   *   device_model    length(trim(...)) BETWEEN 1 AND 64
   *   android_version length(trim(...)) BETWEEN 1 AND 32
   *
   * El mock no valida CHECK: si el parametro se pasa del tope, el test queda
   * verde y Postgres devuelve 500 en produccion. Por eso se afirma el largo del
   * parametro, que es lo unico que el mock no puede tapar.
   */
  it('el mensaje nunca supera el CHECK de error_message, por largo que venga', async () => {
    const { servicio, query } = crearEntorno();

    await servicio.registrarCaidaDeApp(
      USUARIO,
      TENANT,
      // Relleno NO hexadecimal a proposito: con 'a' o '0' el enmascarado lo
      // reemplaza por '[hash]' y el caso dejaria de probar el corte por largo.
      caida({ errorMessage: 'no se pudo leer la etiqueta '.repeat(200) }),
    );

    expect(String(parametrosDe(query, 'INSERT')[7]).length).toBeLessThanOrEqual(2_000);
  });

  it('la pila unida nunca supera el CHECK de stack', async () => {
    const { servicio, query } = crearEntorno();
    // 40 lineas de 1.000 caracteres: la forma de un bundle minificado.
    const pila = Array.from({ length: 40 }, (_, i) => `at fn${i} ${'z'.repeat(1_000)}`).join('\n');

    await servicio.registrarCaidaDeApp(USUARIO, TENANT, caida({ stack: pila }));

    expect(String(parametrosDe(query, 'INSERT')[8]).length).toBeLessThanOrEqual(20_000);
  });

  it('un modelo que queda vacio al depurar no rompe el INSERT: entra un respaldo', async () => {
    const { servicio, query } = crearEntorno();

    // Las comillas las cambia depurarEtiqueta por espacio y despues recorta:
    // esto llega como cadena vacia y el CHECK exige length(trim(...)) >= 1.
    await servicio.registrarCaidaDeApp(
      USUARIO,
      TENANT,
      caida({ deviceModel: '""""', androidVersion: '\\\\' }),
    );

    const parametros = parametrosDe(query, 'INSERT');
    expect(String(parametros[3]).trim().length).toBeGreaterThan(0);
    expect(String(parametros[4]).trim().length).toBeGreaterThan(0);
  });

  it('la hora del evento es la del SERVIDOR, no la del telefono', async () => {
    const { servicio, query, reporter } = crearEntorno();
    const futuroImposible = '2099-01-01T00:00:00.000Z';

    await servicio.registrarCaidaDeApp(USUARIO, TENANT, caida({ occurredAt: futuroImposible }));

    // La hora del telefono se guarda, porque sirve para investigar...
    expect(parametrosDe(query, 'INSERT')[10]).toBe(futuroImposible);
    // ...pero no es la que se manda: un reloj adelantado hace que el proveedor
    // descarte el evento por venir del futuro.
    const evento = (reporter.send as jest.Mock).mock.calls[0]?.[0] as CrashEvent;
    expect(evento.occurredAt.getFullYear()).toBeLessThan(2099);
  });

  it('el id del evento es el de la fila: se puede cruzar el panel con el proveedor', async () => {
    const { servicio, reporter } = crearEntorno();

    await servicio.registrarCaidaDeApp(USUARIO, TENANT, caida());

    const evento = (reporter.send as jest.Mock).mock.calls[0]?.[0] as CrashEvent;
    expect(evento.eventId).toBe(ID_REPORTE.replace(/-/g, ''));
    expect(evento.eventId).toHaveLength(32);
  });

  it('un telefono en bucle se frena y no llega ni a la base ni al proveedor', async () => {
    const { servicio, query, reporter } = crearEntorno({ total: '20' });

    await expect(servicio.registrarCaidaDeApp(USUARIO, TENANT, caida())).resolves.toEqual({
      registrado: false,
      motivo: 'limite_por_hora',
      enviado: false,
    });
    expect(sqlDe(query, 'INSERT')).toBe('');
    expect(reporter.send).not.toHaveBeenCalled();
  });

  it('count(*) llega como TEXTO: 9 no puede leerse como mayor que 20', async () => {
    // Comparado como cadena, '9' > '20' y el guardia numero nueve del turno se
    // quedaria sin reportar nada.
    const { servicio } = crearEntorno({ total: '9' });

    await expect(servicio.registrarCaidaDeApp(USUARIO, TENANT, caida())).resolves.toMatchObject({
      registrado: true,
    });
  });

  it('la purga usa el rowCount del DELETE y no el largo de la tupla', async () => {
    const { servicio, query } = crearEntorno({ borradas: 7 });
    const logger = jest.spyOn(
      (servicio as unknown as { logger: { log: (mensaje: string) => void } }).logger,
      'log',
    );

    await servicio.registrarCaidaDeApp(USUARIO, TENANT, caida());

    expect(sqlDe(query, 'DELETE')).toContain('make_interval(days =>');
    // Un DELETE devuelve [filas, rowCount]: `resultado.length` diria 2 siempre.
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('"borrados":7'));
  });

  it('sin empresa no se guarda nada', async () => {
    const { servicio, query } = crearEntorno();

    await expect(servicio.registrarCaidaDeApp(USUARIO, null, caida())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('si el proveedor no acepta el evento, la fila queda igual guardada', async () => {
    const { servicio, query } = crearEntorno();
    (servicio as unknown as { reporter: CrashReporter }).reporter = {
      enabled: true,
      send: jest.fn(async () => false),
    };

    await expect(servicio.registrarCaidaDeApp(USUARIO, TENANT, caida())).resolves.toEqual({
      registrado: true,
      enviado: false,
    });
    // Sin envio no se marca la fila: `forwarded` sigue en false y se sabe que
    // el proveedor no vio esta caida.
    expect(sqlDe(query, 'UPDATE')).toBe('');
  });

  it('un proveedor que lanza no rompe el registro', async () => {
    const { servicio } = crearEntorno();
    (servicio as unknown as { reporter: CrashReporter }).reporter = {
      enabled: true,
      send: jest.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };

    await expect(servicio.registrarCaidaDeApp(USUARIO, TENANT, caida())).resolves.toMatchObject({
      registrado: true,
      enviado: false,
    });
  });
});

describe('resumen', () => {
  it('agrupa por version, modelo y version de Android', async () => {
    const { servicio, query } = crearEntorno();
    (query as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.trimStart().startsWith('SELECT app_version')) {
        return [
          {
            app_version: '1.4.2',
            device_model: 'Redmi 9A',
            android_version: '10',
            fingerprint: '0123456789abcdef',
            error_name: 'NfcBridgeError',
            error_message: 'no se pudo leer la etiqueta',
            total: '13',
            fatales: '11',
            primera: new Date('2026-08-01T10:00:00.000Z'),
            ultima: new Date('2026-08-03T22:15:00.000Z'),
          },
        ];
      }
      return [];
    });

    const resumen = await servicio.resumen();

    expect(resumen.retencionDias).toBe(RETENCION_CAIDAS_DIAS_DEFECTO);
    expect(resumen.grupos[0]).toEqual({
      huella: '0123456789abcdef',
      appVersion: '1.4.2',
      deviceModel: 'Redmi 9A',
      androidVersion: '10',
      errorName: 'NfcBridgeError',
      errorMessage: 'no se pudo leer la etiqueta',
      total: 13,
      fatales: 11,
      primera: '2026-08-01T10:00:00.000Z',
      ultima: '2026-08-03T22:15:00.000Z',
    });
  });

  it('no deja pedir mas alla de la retencion: mostraria menos sin explicar por que', async () => {
    const { servicio } = crearEntorno();

    await expect(servicio.resumen(365)).resolves.toMatchObject({
      ventanaDias: RETENCION_CAIDAS_DIAS_DEFECTO,
    });
    await expect(servicio.resumen(7)).resolves.toMatchObject({ ventanaDias: 7 });
  });
});

describe('reportarErrorDeServidor', () => {
  it('con el driver apagado no arma ni manda nada', async () => {
    const { servicio } = crearEntorno();
    (servicio as unknown as { reporter: CrashReporter }).reporter = {
      enabled: false,
      send: jest.fn(),
    };

    await expect(
      servicio.reportarErrorDeServidor(new Error('x'), {
        method: 'GET',
        path: '/api/x',
        statusCode: 500,
        tenantId: null,
      }),
    ).resolves.toBe(false);
  });

  it('etiqueta la ruta sin query string ni identificadores', async () => {
    const { servicio, reporter } = crearEntorno();

    await servicio.reportarErrorDeServidor(new Error('columna inexistente'), {
      method: 'GET',
      path: `/api/patrols/${TENANT}/scan?email=jperez@empresa.cl`,
      statusCode: 500,
      tenantId: TENANT,
    });

    const evento = (reporter.send as jest.Mock).mock.calls[0]?.[0] as CrashEvent;
    expect(evento.tags.http_route).toBe('GET /api/patrols/:id/scan');
    expect(evento.tags.source).toBe('api');
    expect(evento.tags.tenant_id).toBe(TENANT);
    expect(evento.release).toBe('voxia-api@1.0.0');
  });

  it('nunca lanza, aunque le pasen cualquier cosa', async () => {
    const { servicio } = crearEntorno();

    await expect(
      servicio.reportarErrorDeServidor('esto no es un Error', {
        method: 'POST',
        path: '/api/x',
        statusCode: 500,
        tenantId: null,
      }),
    ).resolves.toBe(true);
  });
});
