import type { Logger } from '@nestjs/common';
import {
  isRuleAllowedAtScope,
  patrolRulesSchema,
  type PatrolRules,
  type RuleScope,
} from '@voxia/shared';
import type { z } from 'zod';

/** Validadores campo a campo: un override invalido no arrastra al resto. */
const PARTIAL_RULES_SHAPE: Record<string, z.ZodTypeAny> = patrolRulesSchema.partial().shape;

/**
 * El jsonb crudo como objeto. Lo que no sea objeto (un array, un numero suelto,
 * algo escrito a mano) se ignora completo con warning en vez de romper.
 */
export function overridesComoObjeto(
  raw: unknown,
  scope: RuleScope,
  logger: Logger,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(JSON.stringify({ event: 'reglas_overrides_no_objeto', scope }));
    return {};
  }
  return raw as Record<string, unknown>;
}

/**
 * Deja pasar solo lo que existe en el schema, es valido y ademas se puede
 * configurar EN ESE NIVEL de la cascada.
 *
 * Lo tercero importa: una retencion de fotos guardada en un punto de control
 * (por un panel viejo o a mano) se ignora en vez de aplicarse a medias. Y nada
 * de esto lanza: la ronda del guardia no puede caerse por una configuracion mal
 * escrita — se descarta el campo, se avisa en el log y el valor lo pone el nivel
 * de arriba.
 */
export function sanitizeOverrides(
  raw: unknown,
  scope: RuleScope,
  logger: Logger,
): Partial<PatrolRules> {
  const objeto = overridesComoObjeto(raw, scope, logger);
  const valid: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(objeto)) {
    const field = PARTIAL_RULES_SHAPE[key];
    if (!field) {
      logger.warn(JSON.stringify({ event: 'regla_desconocida_descartada', key, scope }));
      continue;
    }
    if (!isRuleAllowedAtScope(key as keyof PatrolRules, scope)) {
      logger.warn(JSON.stringify({ event: 'regla_fuera_de_nivel_descartada', key, scope }));
      continue;
    }
    const parsed = field.safeParse(value);
    if (!parsed.success) {
      logger.warn(JSON.stringify({ event: 'regla_invalida_descartada', key, scope }));
      continue;
    }
    valid[key] = parsed.data;
  }

  return valid as Partial<PatrolRules>;
}
