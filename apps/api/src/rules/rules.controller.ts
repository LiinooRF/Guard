import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PATROL_RULES,
  ROLE_PLATFORMS,
  ROLES,
} from '@voxia/shared';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { UpdateTenantRulesPipe, type UpdateTenantRulesDto } from './dto/update-tenant-rules.dto';
import { RulesService } from './rules.service';

/**
 * Sin decoradores a nivel de clase, a proposito: `defaults` es publico y sin
 * contexto tenant, pero `admin` exige permiso y tenant. Un @Public() de clase
 * abriria tambien los endpoints de administracion (el guard resuelve metodo
 * primero, clase despues).
 */
@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('defaults')
  @Public()
  @SkipTenantContext()
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

  @Get('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  tenantRules() {
    return this.rules.adminView();
  }

  /** El body reemplaza el set completo de overrides; omitir un campo lo vuelve al default. */
  @Put('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  updateTenantRules(@Body(UpdateTenantRulesPipe) input: UpdateTenantRulesDto) {
    return this.rules.updateOverrides(input);
  }
}
