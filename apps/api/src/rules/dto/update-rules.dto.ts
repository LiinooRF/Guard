import { BadRequestException, type PipeTransform } from '@nestjs/common';
import {
  isRuleAllowedAtScope,
  patrolRulesSchema,
  PATROL_RULE_CATALOG,
  type PatrolRules,
  type RuleScope,
} from '@sentrycore/shared';

export type UpdateRulesDto = Partial<PatrolRules>;

// strict(): un campo desconocido en el PUT es 400, no un descarte silencioso.
// El admin que escribio mal el nombre de una regla merece enterarse.
const updateRulesSchema = patrolRulesSchema.partial().strict();

/**
 * Pipe zod manual en vez de class-validator: el DTO de reglas ES el schema
 * compartido de @sentrycore/shared; duplicarlo en decoradores lo desincronizaria
 * del contrato que consumen web y movil.
 *
 * Recibe el nivel de la cascada porque no toda regla se configura en todo nivel
 * (#80/#81): mandar `photoRetentionDays` al nivel de un punto de control es 400
 * y no un valor que se guarda y despues nadie aplica. El catalogo es la fuente
 * de esa decision, asi que agregar un nivel a una regla no toca este archivo.
 */
export class UpdateRulesPipe implements PipeTransform<unknown, UpdateRulesDto> {
  constructor(private readonly scope: RuleScope) {}

  transform(value: unknown): UpdateRulesDto {
    const result = updateRulesSchema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map(
          (issue) => `${issue.path.join('.') || 'overrides'}: ${issue.message}`,
        ),
      );
    }

    const fueraDeNivel = Object.keys(result.data).filter(
      (key) => !isRuleAllowedAtScope(key as keyof PatrolRules, this.scope),
    );
    if (fueraDeNivel.length) {
      throw new BadRequestException(
        fueraDeNivel.map(
          (key) =>
            `${key}: "${PATROL_RULE_CATALOG[key as keyof PatrolRules].label}" no se configura a nivel ${NIVEL_EN_ESPANOL[this.scope]}`,
        ),
      );
    }

    return result.data;
  }
}

const NIVEL_EN_ESPANOL: Record<RuleScope, string> = {
  platform: 'plataforma',
  tenant: 'empresa',
  site: 'recinto',
  checkpoint: 'punto de control',
};
