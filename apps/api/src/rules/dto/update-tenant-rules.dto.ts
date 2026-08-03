import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

export type UpdateTenantRulesDto = Partial<PatrolRules>;

// strict(): un campo desconocido en el PUT es 400, no un descarte silencioso.
// El admin que escribio mal el nombre de una regla merece enterarse.
const updateTenantRulesSchema = patrolRulesSchema.partial().strict();

/**
 * Pipe zod manual en vez de class-validator: el DTO de reglas ES el schema
 * compartido de @voxia/shared; duplicarlo en decoradores lo desincronizaria
 * del contrato que consumen web y movil.
 */
@Injectable()
export class UpdateTenantRulesPipe implements PipeTransform<unknown, UpdateTenantRulesDto> {
  transform(value: unknown): UpdateTenantRulesDto {
    const result = updateTenantRulesSchema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map(
          (issue) => `${issue.path.join('.') || 'overrides'}: ${issue.message}`,
        ),
      );
    }
    return result.data;
  }
}
