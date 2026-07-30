import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@TenantScope()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('tenant')
  @Roles('ADMIN', 'SUPERVISOR')
  tenantOverview(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.dashboard.getTenantOverview(request.user.sub, request.user.role);
  }
}
