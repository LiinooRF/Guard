import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { ScheduleDeletionDto } from './dto/schedule-deletion.dto';
import { TenantDataService } from './tenant-data.service';

class TenantIdParam {
  @IsUUID()
  tenantId!: string;
}

/**
 * Operaciones de SUPERADMIN que cruzan tenants: fuera del contexto tenant por
 * las mismas razones que PlatformController. El cruce real de datos ocurre
 * solo en funciones SECURITY DEFINER que exigen assert_platform_superadmin.
 */
@Controller('platform/tenants')
@SkipTenantContext()
export class TenantDataController {
  constructor(private readonly tenantData: TenantDataService) {}

  // Declarada antes de las rutas :tenantId para que 'deletions' no se
  // intente leer como UUID.
  @Get('deletions')
  @Permissions('platform:tenants:manage')
  pendingDeletions(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.tenantData.pendingDeletions(request.user.sub);
  }

  @Get(':tenantId/export')
  @Permissions('platform:tenants:manage')
  exportTenant(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param() params: TenantIdParam,
  ) {
    return this.tenantData.exportTenant(request.user.sub, params.tenantId);
  }

  @Post(':tenantId/deletion')
  @Permissions('platform:tenants:manage')
  scheduleDeletion(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param() params: TenantIdParam,
    @Body() input: ScheduleDeletionDto,
  ) {
    return this.tenantData.scheduleDeletion(
      request.user.sub,
      params.tenantId,
      input.reason,
      input.retentionDays,
    );
  }

  @Delete(':tenantId/deletion')
  @Permissions('platform:tenants:manage')
  cancelDeletion(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param() params: TenantIdParam,
  ) {
    return this.tenantData.cancelDeletion(request.user.sub, params.tenantId);
  }

  @Post(':tenantId/deletion/execute')
  @Permissions('platform:tenants:manage')
  executeDeletion(
    @Req() request: Request & { user: AuthenticatedUser },
    @Param() params: TenantIdParam,
  ) {
    return this.tenantData.executeDeletion(request.user.sub, params.tenantId);
  }
}
