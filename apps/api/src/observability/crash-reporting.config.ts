import { z } from 'zod';

/**
 * Configuracion del reporte de caidas (#27).
 *
 * POR QUE NO ESTA EN config/env.ts
 * Porque este issue es OPCIONAL y no puede impedir que la API arranque en un
 * entorno que no lo usa. El esquema de config/env.ts es la lista de cosas sin
 * las cuales el producto no funciona; el crash reporting no es una de ellas. Se
 * valida aparte, en la fabrica del modulo, con el mismo criterio de fallar
 * temprano y con un mensaje que se entiende.
 *
 * (Si el integrador prefiere consolidarlo en config/env.ts, en INTEGRACION.md
 * esta el zod exacto para pegar. Este archivo seguiria funcionando igual: lee
 * de process.env, que es de donde @nestjs/config deja las variables tras cargar
 * el .env.)
 *
 * SE LEE process.env Y NO ConfigService a proposito: el zod de validateEnv
 * DESCARTA las claves que no declara, asi que una SENTRY_* pedida por
 * ConfigService podria llegar vacia segun como resuelva la busqueda. main.ts y
 * data-source.ts ya leen process.env directo por lo mismo.
 */
export const crashReportingEnvSchema = z.object({
  /**
   *   off     default. No se envia nada a ningun tercero. El reporte de la app
   *           igual se guarda en la base, que es lo unico que ve el ADMIN.
   *   sentry  se envia al proyecto de Sentry de SENTRY_DSN.
   *
   * Mismo criterio que MAIL_DRIVER y PUSH_DRIVER: el proveedor se elige por
   * entorno y el codigo va contra una interfaz.
   */
  CRASH_REPORT_DRIVER: z.enum(['off', 'sentry']).default('off'),

  /**
   * DSN del proyecto. NO es un secreto —viaja dentro de cualquier APK— pero
   * tampoco se escribe en los logs: quien lo tenga puede inflarnos la cuota del
   * plan gratuito con eventos basura.
   */
  SENTRY_DSN: z.string().optional(),

  /** Ambiente que se muestra en Sentry. Por defecto, el NODE_ENV. */
  SENTRY_ENVIRONMENT: z.string().min(1).max(64).optional(),

  /**
   * Version desplegada, formato `paquete@version`. Sin release, un stacktrace
   * de produccion no se puede mapear a un commit y el reporte no sirve.
   * Dokploy la inyecta desde el tag o el sha del despliegue.
   */
  SENTRY_RELEASE: z.string().min(1).max(120).default('voxia-api@dev'),

  /**
   * Tope del envio hacia el proveedor. Es un limite de INFRAESTRUCTURA, no una
   * regla de negocio: ningun cliente lo configura, y su unico proposito es que
   * un Sentry lento no se convierta en una API lenta.
   */
  CRASH_REPORT_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2_000),

  /**
   * Techo de reportes aceptados por usuario y por hora. Tambien es
   * infraestructura: un telefono en bucle de reinicio manda cientos de caidas
   * identicas y se lleva puesta la cuota del plan gratuito y la tabla.
   */
  CRASH_REPORT_MAX_PER_USER_HOUR: z.coerce.number().int().min(1).max(1_000).default(20),

  NODE_ENV: z.string().default('development'),
});

export type CrashReportingEnv = z.infer<typeof crashReportingEnvSchema>;

/** DSN ya descompuesto. `publicKey` nunca se escribe en un log. */
export interface SentryDsn {
  publicKey: string;
  /** URL completa del endpoint de envelopes, lista para el POST. */
  envelopeUrl: string;
  projectId: string;
}

export interface CrashReportingConfig {
  driver: 'off' | 'sentry';
  dsn: SentryDsn | null;
  environment: string;
  release: string;
  timeoutMs: number;
  maxPerUserHour: number;
}

/**
 * Descompone el DSN `https://<clave>@<host>[/<prefijo>]/<idProyecto>`.
 *
 * Lanza con un mensaje util en vez de dejar que reviente despues, al primer
 * error de produccion, que es cuando menos ganas hay de descubrir que el DSN
 * estaba mal copiado.
 */
export function parseSentryDsn(dsn: string): SentryDsn {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    // Sin eco del valor: el mensaje de error termina en el log de arranque.
    throw new Error('SENTRY_DSN no es una URL valida');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('SENTRY_DSN debe usar http o https');
  }

  const publicKey = decodeURIComponent(url.username);
  if (!publicKey) {
    throw new Error('SENTRY_DSN no trae la clave publica (falta la parte antes de @)');
  }

  const segmentos = url.pathname.split('/').filter((parte) => parte.length > 0);
  const projectId = segmentos.pop();
  if (!projectId || !/^\d+$/.test(projectId)) {
    throw new Error('SENTRY_DSN no termina en un id de proyecto numerico');
  }

  // Sentry self-hosted puede vivir bajo un prefijo de ruta; el SaaS no.
  const prefijo = segmentos.length > 0 ? `/${segmentos.join('/')}` : '';

  return {
    publicKey,
    projectId,
    envelopeUrl: `${url.origin}${prefijo}/api/${projectId}/envelope/`,
  };
}

/**
 * Lee y valida la configuracion. Con el driver en 'off' —el default— no exige
 * nada y no puede impedir un arranque.
 */
export function loadCrashReportingConfig(
  raw: NodeJS.ProcessEnv = process.env,
): CrashReportingConfig {
  const parsed = crashReportingEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`\nConfiguracion de crash reporting invalida:\n${detalle}\n`);
  }

  const env = parsed.data;

  if (env.CRASH_REPORT_DRIVER === 'off') {
    return {
      driver: 'off',
      dsn: null,
      environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
      release: env.SENTRY_RELEASE,
      timeoutMs: env.CRASH_REPORT_TIMEOUT_MS,
      maxPerUserHour: env.CRASH_REPORT_MAX_PER_USER_HOUR,
    };
  }

  if (!env.SENTRY_DSN) {
    throw new Error('CRASH_REPORT_DRIVER=sentry requiere SENTRY_DSN');
  }

  // Un release de mentira en produccion es peor que no tener Sentry: se ven los
  // errores pero no se sabe de que version son, y no se puede decidir si el
  // arreglo ya salio.
  if (env.NODE_ENV === 'production' && env.SENTRY_RELEASE === 'voxia-api@dev') {
    throw new Error('en produccion CRASH_REPORT_DRIVER=sentry requiere SENTRY_RELEASE real');
  }

  return {
    driver: 'sentry',
    dsn: parseSentryDsn(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    timeoutMs: env.CRASH_REPORT_TIMEOUT_MS,
    maxPerUserHour: env.CRASH_REPORT_MAX_PER_USER_HOUR,
  };
}

/** Token de inyeccion de la configuracion. */
export const CRASH_REPORTING_CONFIG = Symbol('CRASH_REPORTING_CONFIG');
