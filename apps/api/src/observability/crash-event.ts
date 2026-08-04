/**
 * El evento de caida, en el unico formato que circula por este modulo (#27).
 *
 * NO ES UN OBJETO LIBRE, Y ESA ES LA IDEA. Todo lo que sale hacia el proveedor
 * externo se arma campo por campo a partir de este tipo. Es la misma decision
 * que tomo StructuredLogger cuando se nego a serializar objetos arbitrarios: un
 * `extra: unknown` termina, tarde o temprano, con el objeto `user` completo
 * adentro y el nombre del guardia viajando a un tercero.
 *
 * Lista blanca primero, enmascarado despues. El enmascarado (crash-scrubber.ts)
 * es la segunda reja, para los dos campos que por naturaleza son texto libre:
 * el mensaje del error y la pila.
 */

/** De donde salio la caida. */
export type CrashSource = 'api' | 'app';

/** Severidad, con los nombres que entiende Sentry. */
export type CrashLevel = 'error' | 'fatal';

/**
 * Etiquetas permitidas. El tipo es cerrado a proposito: agregar una etiqueta
 * obliga a pasar por aca y a preguntarse si identifica a una persona.
 *
 * `tenant_id` es un uuid de EMPRESA, no de persona, y es lo que pide el issue
 * para poder decir "esta empresa tiene una version que se cae".
 */
export interface CrashTags {
  source: CrashSource;
  tenant_id?: string;
  app_version?: string;
  device_model?: string;
  android_version?: string;
  bridge_protocol?: string;
  /** Metodo y ruta ya enmascarada, solo para errores del servidor. */
  http_route?: string;
  fatal?: 'true' | 'false';
}

export interface CrashEvent {
  /** 32 hex sin guiones: es el formato que exige el protocolo de Sentry. */
  eventId: string;
  level: CrashLevel;
  /** Momento del evento. Se serializa en ISO-8601 con zona, siempre UTC. */
  occurredAt: Date;
  /** Version desplegada. Sin esto un stacktrace minificado no sirve de nada. */
  release: string;
  environment: string;
  /** Nombre de la excepcion: 'TypeError', 'NfcBridgeError'. */
  errorName: string;
  /** Mensaje YA depurado. */
  errorMessage: string;
  /** Lineas de pila YA depuradas, en el orden original (la mas reciente primero). */
  stack: readonly string[];
  /** Huella estable para agrupar. 16 hex. */
  fingerprint: string;
  tags: CrashTags;
  /** Correlaciona con el log estructurado. No identifica a nadie. */
  requestId: string | null;
}

/**
 * El transporte. Existe para que apagar el reporte sea cambiar de
 * implementacion y no llenar el codigo de `if (sentryHabilitado)`.
 */
export interface CrashReporter {
  /** Falso cuando el driver esta en 'off': el llamador puede ahorrarse el trabajo. */
  readonly enabled: boolean;
  /** True si el evento salio. NUNCA lanza: un proveedor caido no rompe la API. */
  send(event: CrashEvent): Promise<boolean>;
}

/** Token de inyeccion del transporte. */
export const CRASH_REPORTER = Symbol('CRASH_REPORTER');
