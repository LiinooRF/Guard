import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { UpdateRulesPipe, type UpdateRulesDto } from './dto/update-rules.dto';
import { PlatformRulesService } from './platform-rules.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Nivel plataforma de la cascada (#80): el default con el que opera una empresa
 * que no configuro nada.
 *
 * Sin @TenantScope y con @SkipTenantContext, como el resto de /platform: el
 * SUPERADMIN no tiene empresa en su sesion, y abrir una transaccion con contexto
 * tenant no tendria ninguno que poner.
 *
 * Ruta bajo /platform/rules para no chocar con PlatformController
 * (/platform/tenants) ni con PlatformOpsController (/platform/provisioning y
 * /platform/metrics).
 */
@Controller('platform/rules')
@SkipTenantContext()
export class PlatformRulesController {
  constructor(private readonly rules: PlatformRulesService) {}

  @Get()
  @Permissions('platform:tenants:manage')
  platformRules() {
    return this.rules.view();
  }

  /** Reemplaza el set completo; omitir un campo lo vuelve al default de rules.ts. */
  @Put()
  @Permissions('platform:tenants:manage')
  updatePlatformRules(
    @Req() request: Autenticado,
    @Body(new UpdateRulesPipe('platform')) input: UpdateRulesDto,
  ) {
    return this.rules.replace(request.user.sub, input);
  }
}
