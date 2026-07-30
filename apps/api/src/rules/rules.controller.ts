import { Controller, Get } from '@nestjs/common';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PATROL_RULES,
  ROLE_PLATFORMS,
  ROLES,
} from '@voxia/shared';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';

/**
 * Endpoint de humo del scaffolding: prueba que `@voxia/shared` se resuelve
 * correctamente desde la API. Cuando Dev D implemente el issue #16, este
 * controlador se reemplaza por el motor de reglas real con la cascada
 * plataforma -> tenant -> recinto -> punto.
 */
@Controller('rules')
@SkipTenantContext()
export class RulesController {
  @Get('defaults')
  defaults() {
    return {
      roles: ROLES,
      platforms: ROLE_PLATFORMS,
      patrolRules: DEFAULT_PATROL_RULES,
      featureFlags: DEFAULT_FEATURE_FLAGS,
      _nota:
        'Valores por defecto. Un tenant nuevo opera con esto sin configurar nada. ' +
        'La cascada por tenant, recinto y punto es el issue #16.',
    };
  }
}
