import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { PlatformConfigAuditQuery } from './dto/config-audit-query.dto';
import { PlatformConfigAuditService } from './platform-config-audit.service';

class TenantIdParam {
  @IsUUID()
  tenantId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * El mismo historial, visto por el SUPERADMIN (#84).
 *
 * Fuera del contexto tenant, por las mismas razones que TenantDataController: el
 * SUPERADMIN no tiene empresa en su sesion. El cruce real de datos ocurre solo
 * dentro de funciones SECURITY DEFINER que exigen assert_platform_superadmin, y
 * ese chequeo no depende de que este decorador este bien puesto.
 *
 * Se reusa `platform:tenants:manage` en vez de inventar un permiso: es el mismo
 * que ya habilita exportar los datos de una empresa, que es estrictamente mas
 * que leer su historial de configuracion.
 */
@Controller('platform')
@SkipTenantContext()
export class PlatformConfigAuditController {
  constructor(private readonly configAudit: PlatformConfigAuditService) {}

  /**
   * Declarada antes de la ruta con :tenantId para que 'config-audit' no se
   * intente leer como UUID.
   */
  @Get('config-audit')
  @Permissions('platform:tenants:manage')
  platformHistory(@Req() request: Autenticado, @Query() query: PlatformConfigAuditQuery) {
    return this.configAudit.platformHistory(request.user.sub, query);
  }

  @Get('tenants/:tenantId/config-audit')
  @Permissions('platform:tenants:manage')
  tenantHistory(
    @Req() request: Autenticado,
    @Param() params: TenantIdParam,
    @Query() query: PlatformConfigAuditQuery,
  ) {
    return this.configAudit.tenantHistory(request.user.sub, params.tenantId, query);
  }
}
