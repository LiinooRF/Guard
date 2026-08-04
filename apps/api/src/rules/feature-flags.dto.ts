import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { featureFlagsSchema, type FeatureFlags } from '@voxia/shared';
import { IsUUID, Matches } from 'class-validator';

export type UpdateFeatureFlagsDto = Partial<FeatureFlags>;

// strict(): un modulo desconocido en el PUT es 400 y no un descarte silencioso.
// Quien escribio mal el nombre de un modulo merece enterarse en vez de creer que
// lo activo.
const updateFeatureFlagsSchema = featureFlagsSchema.partial().strict();

/**
 * Pipe zod manual en vez de class-validator, por el mismo motivo que
 * UpdateRulesPipe: el DTO ES el schema compartido de @voxia/shared, y
 * duplicarlo en decoradores lo desincronizaria del contrato que consumen web y
 * movil.
 *
 * Aca NO se valida la licencia: eso depende del tenant de la sesion y de lo que
 * diga la base, y un pipe no tiene esos datos. Lo hace el servicio, que ademas
 * tiene detras el trigger de la base.
 */
export class UpdateFeatureFlagsPipe
  implements PipeTransform<unknown, UpdateFeatureFlagsDto>
{
  transform(value: unknown): UpdateFeatureFlagsDto {
    const resultado = updateFeatureFlagsSchema.safeParse(value ?? {});
    if (!resultado.success) {
      throw new BadRequestException(
        resultado.error.issues.map(
          (issue) => `${issue.path.join('.') || 'modulos'}: ${issue.message}`,
        ),
      );
    }
    return resultado.data;
  }
}

/** El plan es una clave corta del catalogo comercial, no un uuid. */
export class PlanKeyParam {
  @Matches(/^[a-z0-9][a-z0-9_-]{1,39}$/, {
    message: 'planKey: el plan se identifica con una clave corta en minusculas',
  })
  planKey!: string;
}

export class FeatureTenantIdParam {
  @IsUUID()
  tenantId!: string;
}
