import type { Logger } from '@nestjs/common';
import { DEFAULT_FEATURE_FLAGS, featureFlagsSchema, type FeatureFlags } from '@sentrycore/shared';
import type { z } from 'zod';

/**
 * Catalogo y resolucion de los modulos que se venden por plan (#82).
 *
 * Codigo puro: no toca la base ni Nest. Lo que decide que ve una empresa se
 * prueba aca, sin mocks de driver de por medio.
 *
 * Los flags en si viven en `featureFlagsSchema` de @sentrycore/shared, que es el
 * contrato que comparten api, web y movil. Este archivo agrega lo que le falta
 * a ese schema para poder venderlos: como se llama cada modulo en la interfaz,
 * que deja de verse cuando se apaga, y como se resuelven los cuatro niveles.
 */

export type FeatureFlagKey = keyof FeatureFlags;

/**
 * Los cuatro niveles, del mas general al mas especifico.
 *
 *   producto  ->  plan  ->  empresa  ->  admin
 *
 * Los tres primeros arman el TECHO (que incluye la licencia) y solo el
 * SUPERADMIN los mueve. El cuarto es la preferencia del ADMIN y solo puede
 * apagar dentro de ese techo, nunca ampliarlo.
 */
export const FEATURE_LEVELS = ['producto', 'plan', 'empresa', 'admin'] as const;
export type FeatureLevel = (typeof FEATURE_LEVELS)[number];

export const FEATURE_LEVEL_LABELS: Record<FeatureLevel, string> = {
  producto: 'Valor de fabrica',
  plan: 'Plan contratado',
  empresa: 'Acuerdo con esta empresa',
  admin: 'Decision del administrador',
};

export interface FeatureModule<K extends FeatureFlagKey = FeatureFlagKey> {
  key: K;
  /** Nombre corto para el panel. */
  label: string;
  /** Que hace, en lenguaje del jefe de operaciones y no del ingeniero. */
  description: string;
  /** Que deja de verse cuando el modulo esta apagado. */
  whenOff: string;
  default: boolean;
}

export type AnyFeatureModule = FeatureModule<FeatureFlagKey>;

/**
 * El tipo obliga a que TODO flag de featureFlagsSchema tenga ficha y a que no
 * sobre ninguna: agregar un modulo sin describirlo no compila. Es la garantia
 * de que el panel del SUPERADMIN nunca muestra una casilla sin explicacion.
 */
type FeatureCatalog = { [K in FeatureFlagKey]: FeatureModule<K> };

export const FEATURE_CATALOG: FeatureCatalog = {
  map: {
    key: 'map',
    label: 'Mapa en vivo',
    description:
      'Muestra en un mapa por donde va el guardia durante la ronda y donde quedo marcado cada punto.',
    whenOff:
      'Desaparece el mapa del panel. La ronda se sigue igual por la lista de puntos y sus horas.',
    default: DEFAULT_FEATURE_FLAGS.map,
  },
  chartsBySite: {
    key: 'chartsBySite',
    label: 'Graficas por sucursal',
    description:
      'Compara en graficos el cumplimiento de cada recinto, ademas de mostrarlo en tablas.',
    whenOff: 'Desaparecen los graficos comparativos. Las cifras siguen estando en las tablas.',
    default: DEFAULT_FEATURE_FLAGS.chartsBySite,
  },
  photoAppendix: {
    key: 'photoAppendix',
    label: 'Anexo fotografico en el informe',
    description:
      'Agrega al final del informe las fotos que tomo el guardia en cada punto que las exigia.',
    whenOff:
      'El informe sale sin el anexo de fotos y el anexo desaparece del menu. Las fotos se siguen guardando: no se borra evidencia.',
    default: DEFAULT_FEATURE_FLAGS.photoAppendix,
  },
  // `incidents` y `gpsTracking` se retiraron del catalogo (#286): eran modulos
  // MUERTOS. Novedades/panico lo gobierna el permiso RBAC `incidents:create`, y
  // el recorrido, la regla `gpsTrackingEnabled` — no estos flags, que nadie leia.
  crashReporting: {
    key: 'crashReporting',
    label: 'Reporte de fallas de la app',
    description:
      'Cuando la app del guardia se cierra sola, manda el detalle tecnico al proveedor para poder repararla.',
    whenOff: 'No se manda nada. Una falla hay que reportarla a mano.',
    default: DEFAULT_FEATURE_FLAGS.crashReporting,
  },
};

/** El catalogo como lista, en el orden en que se declaro. */
export const FEATURE_MODULE_LIST: readonly AnyFeatureModule[] = Object.values(
  FEATURE_CATALOG,
) as AnyFeatureModule[];

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_CATALOG) as FeatureFlagKey[];

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_CATALOG, key);
}

/* ------------------------------------------------------------------ *
 * Saneamiento de lo que viene de la base
 * ------------------------------------------------------------------ */

/** Validadores campo a campo: un flag invalido no arrastra al resto. */
const FLAG_SHAPE: Record<string, z.ZodTypeAny> = featureFlagsSchema.partial().shape;

/** Como se llama cada capa en la base, para que los logs digan de donde salio. */
export type FeatureSourceTable = 'plan' | 'empresa' | 'admin';

/**
 * El jsonb crudo como objeto. Lo que no sea objeto (un array, un numero suelto,
 * algo escrito a mano) se ignora completo con warning en vez de romper.
 */
export function flagsComoObjeto(
  raw: unknown,
  nivel: FeatureSourceTable,
  logger: Logger,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(JSON.stringify({ event: 'modulos_no_objeto', nivel }));
    return {};
  }
  return raw as Record<string, unknown>;
}

/**
 * Deja pasar solo los modulos que existen en el catalogo y con valor booleano.
 *
 * Nada de esto lanza: un modulo desconocido guardado por un panel viejo se
 * descarta con warning y la empresa sigue operando. Lo contrario seria dejar sin
 * app a los guardias por una casilla mal escrita.
 */
export function sanitizeFeatureFlags(
  raw: unknown,
  nivel: FeatureSourceTable,
  logger: Logger,
): Partial<FeatureFlags> {
  const objeto = flagsComoObjeto(raw, nivel, logger);
  const valido: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(objeto)) {
    const campo = FLAG_SHAPE[key];
    if (!campo) {
      logger.warn(JSON.stringify({ event: 'modulo_desconocido_descartado', key, nivel }));
      continue;
    }
    const parsed = campo.safeParse(value);
    if (!parsed.success) {
      logger.warn(JSON.stringify({ event: 'modulo_invalido_descartado', key, nivel }));
      continue;
    }
    valido[key] = parsed.data;
  }

  return valido as Partial<FeatureFlags>;
}

/* ------------------------------------------------------------------ *
 * Resolucion de la cascada
 * ------------------------------------------------------------------ */

export interface FeatureFlagLayers {
  /** Lo que incluye el plan de licencia contratado. */
  plan?: Partial<FeatureFlags>;
  /** Concesion puntual a esta empresa. Le gana al plan. */
  empresa?: Partial<FeatureFlags>;
  /** Lo que el ADMIN dejo prendido o apagado. */
  admin?: Partial<FeatureFlags>;
}

export interface ResolvedFeatureFlags {
  /** Lo que la licencia INCLUYE. Es el techo: el admin no lo puede subir. */
  entitlements: FeatureFlags;
  /** Quien decidio cada valor del techo. */
  entitlementSources: Record<FeatureFlagKey, FeatureLevel>;
  /** Modulo efectivo: incluido en la licencia Y encendido por el admin. */
  enabled: FeatureFlags;
  /** Quien decidio cada valor efectivo. */
  sources: Record<FeatureFlagKey, FeatureLevel>;
  /** Modulos que el admin puede prender o apagar. Los demas no se le muestran. */
  editable: readonly AnyFeatureModule[];
}

/**
 * Resuelve los cuatro niveles.
 *
 *   techo    = producto, pisado por el plan, pisado por la concesion a la empresa
 *   efectivo = techo Y preferencia del admin
 *
 * El AND es lo que hace que quitar un modulo de la licencia lo apague al toque
 * en todas partes, sin tener que ir a limpiar lo que el admin habia dejado
 * escrito. Y es el motivo de que la preferencia guardada nunca alcance para
 * activar nada: si el techo dice que no, no hay preferencia que lo levante.
 */
export function resolveFeatureFlags(layers: FeatureFlagLayers): ResolvedFeatureFlags {
  const entitlements = {} as Record<FeatureFlagKey, boolean>;
  const entitlementSources = {} as Record<FeatureFlagKey, FeatureLevel>;
  const enabled = {} as Record<FeatureFlagKey, boolean>;
  const sources = {} as Record<FeatureFlagKey, FeatureLevel>;

  for (const key of FEATURE_FLAG_KEYS) {
    let permitido: boolean = DEFAULT_FEATURE_FLAGS[key];
    let permitidoPor: FeatureLevel = 'producto';

    // undefined no es un valor: es "este nivel no opina".
    const delPlan = layers.plan?.[key];
    if (delPlan !== undefined) {
      permitido = delPlan;
      permitidoPor = 'plan';
    }
    const deLaEmpresa = layers.empresa?.[key];
    if (deLaEmpresa !== undefined) {
      permitido = deLaEmpresa;
      permitidoPor = 'empresa';
    }

    const escritoPorElAdmin = layers.admin?.[key];
    const preferido = escritoPorElAdmin ?? DEFAULT_FEATURE_FLAGS[key];

    entitlements[key] = permitido;
    entitlementSources[key] = permitidoPor;
    enabled[key] = permitido && preferido;
    // Si la licencia lo niega, el responsable es quien la definio y no el admin:
    // el panel tiene que poder decir "esto no viene en tu plan" y no "lo
    // apagaste tu".
    sources[key] = !permitido
      ? permitidoPor
      : escritoPorElAdmin !== undefined
        ? 'admin'
        : permitidoPor;
  }

  return {
    entitlements: entitlements as FeatureFlags,
    entitlementSources,
    enabled: enabled as FeatureFlags,
    sources,
    editable: FEATURE_MODULE_LIST.filter((modulo) => entitlements[modulo.key]),
  };
}

/**
 * Modulos que la preferencia intenta prender y la licencia no incluye.
 *
 * Devuelve las fichas y no las claves porque el error que ve el admin nombra los
 * modulos como los conoce el, no como se llaman en el codigo.
 */
export function modulesOutsideLicense(
  preferencias: Partial<FeatureFlags>,
  entitlements: FeatureFlags,
): readonly AnyFeatureModule[] {
  return FEATURE_MODULE_LIST.filter(
    (modulo) => preferencias[modulo.key] === true && !entitlements[modulo.key],
  );
}
