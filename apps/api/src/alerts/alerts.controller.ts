import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AlertsService } from './alerts.service';
import { AttendAlertDto } from './dto/attend-alert.dto';

class AlertParam { @IsUUID() alertId!: string; }
type Authenticated = Request & { user: AuthenticatedUser };

@Controller('supervisor/alerts')
@TenantScope()
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @Permissions('patrols:monitor')
  list(@Req() request: Authenticated) { return this.alerts.list(request.user.sub); }

  @Post(':alertId/attend')
  @Permissions('patrols:monitor')
  attend(@Param() params: AlertParam, @Body() input: AttendAlertDto, @Req() request: Authenticated) {
    return this.alerts.attend(params.alertId, request.user.sub, input.comment);
  }
}
