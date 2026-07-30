import { z } from 'zod';

/**
 * Reglas configurables de VoxIA Control.
 *
 * Las reglas que dio el cliente (umbral de 70%, foto obligatoria fuera de
 * horario) son EL DEFAULT DE UN CLIENTE, no la ley del producto. Esto es un
 * SaaS: el siguiente cliente va a querer 85% y foto siempre. Por eso todo
 * parametro vive aca con un default sensato y se puede sobreescribir sin deploy.
 *
 * Resolucion en cascada, gana el mas especifico:
 *
 *     plataforma  ->  tenant  ->  recinto  ->  punto
 *
 * Ver issue #16 (Motor de reglas y funciones configurables por tenant).
 */
export const patrolRulesSchema = z.object({
  /** Bajo este porcentaje de cumplimiento, el informe va DIRECTO al admin. */
  complianceThreshold: z.number().int().min(0).max(100).default(70),

  /** Fuera del horario habil del recinto, la foto es obligatoria en todo punto. */
  photoRequiredOutsideHours: z.boolean().default(true),

  /** En accesos, puertas y porterias la foto es obligatoria siempre. */
  photoRequiredOnCritical: z.boolean().default(true),

  /** Si es true y el guardia niega el permiso de ubicacion, no puede iniciar la ronda. */
  gpsSharingRequired: z.boolean().default(true),

  /** Radio en metros para aceptar que un escaneo se hizo realmente en el punto. */
  gpsValidationRadiusM: z.number().int().min(5).max(1000).default(50),

  /**
   * Orden aleatorio anti-predictibilidad.
   *
   * En vigilancia una ronda siempre igual es una ronda predecible, y la
   * predictibilidad es exactamente lo que explota quien quiere entrar: sabe que
   * el guardia pasa por la bodega a las 23:40 y vuelve en 45 minutos. Es una
   * funcion de SEGURIDAD, no una preferencia estetica.
   */
  randomizeRouteOrder: z.boolean().default(false),

  /** Enviar el informe automaticamente al escanear el punto de cierre. */
  autoSendReportOnClose: z.boolean().default(true),

  /**
   * Permitir QR como respaldo cuando el NFC falla o el telefono no lo tiene.
   * El escaneo queda marcado con su metodo: un QR se puede fotografiar y reusar,
   * una etiqueta NFC hay que ir a tocarla.
   */
  allowQrFallback: z.boolean().default(true),

  /** Minutos tras los cuales una ronda sin cerrar se marca como vencida. */
  maxPatrolDurationMin: z.number().int().min(5).max(1440).default(480),

  /** Dias que se conserva la evidencia fotografica. */
  photoRetentionDays: z.number().int().min(30).max(3650).default(365),

  /** Intentos de login fallidos antes de bloquear temporalmente. */
  maxLoginAttempts: z.number().int().min(3).max(20).default(5),
});

export type PatrolRules = z.infer<typeof patrolRulesSchema>;

/** Defaults completos. Un tenant nuevo opera sin configurar nada. */
export const DEFAULT_PATROL_RULES: PatrolRules = patrolRulesSchema.parse({});

/**
 * Modulos que se prenden y apagan por tenant o por plan de licencia.
 *
 * Esto es lo que permite vender planes distintos sin mantener versiones
 * distintas del producto. Un modulo apagado DESAPARECE de la interfaz; no queda
 * visible y bloqueado.
 */
export const featureFlagsSchema = z.object({
  map: z.boolean().default(true),
  chartsBySite: z.boolean().default(true),
  photoAppendix: z.boolean().default(true),
  incidents: z.boolean().default(true),
  gpsTracking: z.boolean().default(true),
  /** Crash reporting. Opcional, fuera del corte de 1 mes. */
  crashReporting: z.boolean().default(false),
});

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = featureFlagsSchema.parse({});

/** Niveles de la cascada, del mas general al mas especifico. */
export const RULE_SCOPES = ['platform', 'tenant', 'site', 'checkpoint'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/**
 * Resuelve la configuracion efectiva aplicando la cascada. El nivel mas
 * especifico gana. La app pide el resultado ya resuelto y no reimplementa esto.
 */
export function resolveRules(
  overrides: Partial<Record<RuleScope, Partial<PatrolRules>>>,
): PatrolRules {
  let acc: PatrolRules = { ...DEFAULT_PATROL_RULES };
  for (const scope of RULE_SCOPES) {
    const layer = overrides[scope];
    if (layer) acc = { ...acc, ...layer };
  }
  return patrolRulesSchema.parse(acc);
}
