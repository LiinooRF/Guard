import type { SentryDsn } from './crash-reporting.config';
import type { CrashEvent } from './crash-event';

/**
 * Protocolo de envio a Sentry, escrito a mano (#27).
 *
 * POR QUE NO SE USA @sentry/node
 * 1. El SDK oficial se engancha a `process.on('uncaughtException')`, parchea
 *    http y arrastra instrumentacion automatica que captura cuerpos de request
 *    y cabeceras. En un producto donde el requisito numero uno es que no se
 *    filtren datos de otra empresa, una captura automatica es exactamente lo
 *    que no se quiere: lo que viaja tiene que ser una lista blanca escrita a
 *    mano, y eso es este archivo.
 * 2. Un issue marcado "opcional y fuera del corte" no puede meter una
 *    dependencia de decenas de paquetes en el arbol compartido.
 *
 * Lo que se manda es un "envelope": tres lineas de JSON separadas por saltos de
 * linea —cabecera del sobre, cabecera del item, item— contra
 * `POST /api/<proyecto>/envelope/`. Es el formato publico y estable de Sentry.
 *
 * SI ALGUN DIA SE QUIERE EL SDK: la interfaz `CrashReporter` es el punto de
 * cambio. Nada fuera de este modulo sabe como viaja el evento.
 */

/** Version del protocolo. 7 es la vigente desde hace años. */
const SENTRY_VERSION = 7;

/** Se ve en el evento; ayuda a distinguir estos eventos de los de un SDK real. */
export const SENTRY_CLIENT = 'voxia-crash-reporter/1.0';

interface SentryFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  /** Marca los cuadros de nuestro codigo; Sentry los destaca sobre los de librerias. */
  in_app: boolean;
}

/**
 * Convierte una linea de pila en un cuadro. Acepta las dos formas que llegan:
 * la de V8 (`at fn (archivo:12:3)`) y la de Hermes/React Native
 * (`fn@archivo:12:3`).
 *
 * Si no reconoce la forma NO descarta la linea: la deja como nombre de archivo.
 * Perder un cuadro por no saber parsearlo es perder justo el que importa.
 */
export function parsearCuadro(linea: string): SentryFrame {
  const coincidencia =
    /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(linea) ??
    /^(.*?)@(.+?):(\d+):(\d+)$/.exec(linea);

  if (!coincidencia) return { filename: linea, in_app: false };

  const [, funcion, archivo, fila, columna] = coincidencia;
  if (!archivo) return { filename: linea, in_app: false };

  return {
    filename: archivo,
    ...(funcion ? { function: funcion } : {}),
    ...(fila ? { lineno: Number(fila) } : {}),
    ...(columna ? { colno: Number(columna) } : {}),
    in_app: esCodigoPropio(archivo),
  };
}

function esCodigoPropio(archivo: string): boolean {
  return archivo.length > 0 && !/node_modules|^node:|^internal\//.test(archivo);
}

/**
 * El cuerpo del evento. Campo por campo: aca no entra nada que no este escrito
 * en esta funcion.
 */
export function construirEventoSentry(evento: CrashEvent): Record<string, unknown> {
  const cuadros = evento.stack.map(parsearCuadro).reverse(); // Sentry: el mas reciente al final

  const etiquetas: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(evento.tags)) {
    if (typeof valor === 'string' && valor.length > 0) etiquetas[clave] = valor;
  }

  const contexts: Record<string, unknown> = {};
  if (evento.tags.device_model) {
    contexts.device = { model: evento.tags.device_model };
  }
  if (evento.tags.android_version) {
    contexts.os = { name: 'Android', version: evento.tags.android_version };
  }

  return {
    event_id: evento.eventId,
    timestamp: evento.occurredAt.toISOString(),
    platform: evento.tags.source === 'app' ? 'javascript' : 'node',
    level: evento.level,
    logger: `voxia.${evento.tags.source}`,
    release: evento.release,
    environment: evento.environment,
    // Agrupacion nuestra y no la de Sentry: la nuestra ya ignora los numeros
    // variables del mensaje, asi que agrupa mejor y —sobre todo— agrupa IGUAL
    // que el panel del ADMIN. Dos paneles que agrupan distinto son dos verdades.
    fingerprint: [evento.fingerprint],
    ...(evento.tags.http_route ? { transaction: evento.tags.http_route } : {}),
    tags: etiquetas,
    ...(evento.requestId ? { extra: { request_id: evento.requestId } } : {}),
    ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
    exception: {
      values: [
        {
          type: evento.errorName,
          value: evento.errorMessage,
          ...(cuadros.length > 0 ? { stacktrace: { frames: cuadros } } : {}),
        },
      ],
    },
  };
}

/**
 * El sobre completo, listo para el POST.
 *
 * La cabecera del sobre NO lleva el `dsn`: es opcional —la autenticacion va en
 * la cabecera HTTP— y sin el, el cuerpo no contiene ninguna credencial. Asi, si
 * alguna vez alguien registra el cuerpo para depurar, no registra la clave.
 */
export function construirEnvelope(evento: CrashEvent): string {
  const cuerpo = JSON.stringify(construirEventoSentry(evento));
  const cabeceraSobre = JSON.stringify({
    event_id: evento.eventId,
    sent_at: new Date().toISOString(),
  });
  const cabeceraItem = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: Buffer.byteLength(cuerpo, 'utf8'),
  });

  return `${cabeceraSobre}\n${cabeceraItem}\n${cuerpo}\n`;
}

/** Cabeceras del POST. `X-Sentry-Auth` es lo unico que lleva la clave publica. */
export function cabecerasEnvelope(dsn: SentryDsn): Record<string, string> {
  return {
    'content-type': 'application/x-sentry-envelope',
    'x-sentry-auth': [
      `Sentry sentry_version=${SENTRY_VERSION}`,
      `sentry_client=${SENTRY_CLIENT}`,
      `sentry_key=${dsn.publicKey}`,
    ].join(', '),
  };
}
