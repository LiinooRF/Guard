import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { FeatureFlagsPlatformService } from './feature-flags-platform.service';
import {
  FeatureTenantIdParam,
  PlanKeyParam,
  UpdateFeatureFlagsPipe,
  type UpdateFeatureFlagsDto,
} from './feature-flags.dto';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Lo que el SUPERADMIN habilita: modulos por plan de licencia y concesiones a
 * una empresa puntual (#82).
 *
 * Sin @TenantScope y con @SkipTenantContext, como el resto de /platform: el
 * SUPERADMIN no tiene empresa en su sesion y abrir una transaccion con contexto
 * tenant no tendria ninguno que poner.
 *
 * Ruta bajo /platform/features para no chocar con PlatformController
 * (/platform/tenants), PlatformRulesController (/platform/rules) ni
 * PlatformOpsController (/platform/provisioning y /platform/metrics).
 */
@Controller('platform/features')
@SkipTenantContext()
export class FeatureFlagsPlatformController {
  constructor(private readonly features: FeatureFlagsPlatformService) {}

  @Get('plans')
  @Permissions('platform:tenants:manage')
  plans(@Req() request: Autenticado) {
    return this.features.plans(request.user.sub);
  }

  /** Reemplaza el set completo del plan; omitir un modulo lo vuelve al de fabrica. */
  @Put('plans/:planKey')
  @Permissions('platform:tenants:manage')
  updatePlan(
    @Req() request: Autenticado,
    @Param() params: PlanKeyParam,
    @Body(new UpdateFeatureFlagsPipe()) input: UpdateFeatureFlagsDto,
  ) {
    return this.features.replacePlanFeatures(request.user.sub, params.planKey, input);
  }

  @Get('tenants/:tenantId')
  @Permissions('platform:tenants:manage')
  tenantFeatures(@Req() request: Autenticado, @Param() params: FeatureTenantIdParam) {
    return this.features.tenantFeatures(request.user.sub, params.tenantId);
  }

  /**
   * Concesion a UNA empresa: le gana al plan, en los dos sentidos. Sirve para
   * regalar un modulo que su plan no trae y tambien para quitarle uno que si.
   */
  @Put('tenants/:tenantId')
  @Permissions('platform:tenants:manage')
  updateTenantFeatures(
    @Req() request: Autenticado,
    @Param() params: FeatureTenantIdParam,
    @Body(new UpdateFeatureFlagsPipe()) input: UpdateFeatureFlagsDto,
  ) {
    return this.features.replaceTenantFeatures(request.user.sub, params.tenantId, input);
  }
}
