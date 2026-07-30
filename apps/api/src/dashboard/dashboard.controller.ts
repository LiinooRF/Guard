import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@TenantScope()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('tenant')
  @Permissions('tenant:dashboard:read')
  tenantOverview(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.dashboard.getTenantOverview(request.user.sub, request.user.role);
  }
}
