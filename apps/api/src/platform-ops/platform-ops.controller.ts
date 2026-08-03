import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { PlatformMetricsQueryDto } from './dto/platform-metrics-query.dto';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { PlatformMetricsService } from './platform-metrics.service';
import { ProvisioningService } from './provisioning.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Operaciones de plataforma que no son ABM de un tenant. Sin @TenantScope y con
 * @SkipTenantContext: el SUPERADMIN no tiene empresa en su sesion, asi que el
 * interceptor no debe abrir una transaccion con contexto — no habria ninguno que
 * poner y todo devolveria vacio.
 *
 * Rutas bajo /platform pero fuera de /platform/tenants para no chocar con
 * PlatformController ni con TenantDataController, que ya cuelgan de ahi.
 */
@Controller('platform')
@SkipTenantContext()
export class PlatformOpsController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly metrics: PlatformMetricsService,
  ) {}

  @Post('provisioning')
  @Permissions('platform:tenants:manage')
  provision(@Req() request: Autenticado, @Body() input: ProvisionTenantDto) {
    return this.provisioning.altaCompleta(request.user.sub, input);
  }

  @Get('metrics')
  @Permissions('platform:metrics:read')
  platformMetrics(@Req() request: Autenticado, @Query() query: PlatformMetricsQueryDto) {
    return this.metrics.overview(request.user.sub, query.inactivityDays);
  }
}
