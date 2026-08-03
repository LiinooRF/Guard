import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { FalseAlarmDto } from './dto/false-alarm.dto';
import { UpdateEscalationPoliciesDto } from './dto/update-escalation-policies.dto';
import { EscalationService } from './escalation.service';

class NotificationParam {
  @IsUUID()
  notificationId!: string;
}

class EventParam {
  @IsUUID()
  eventId!: string;
}

@Controller('escalation')
@TenantScope()
export class EscalationController {
  constructor(private readonly escalation: EscalationService) {}

  @Get('policies')
  @Permissions('tenant:security:manage')
  getPolicies() {
    return this.escalation.listPolicies();
  }

  /** Reemplaza el set completo: la criticidad omitida vuelve a su default. */
  @Put('policies')
  @Permissions('tenant:security:manage')
  replacePolicies(@Body() input: UpdateEscalationPoliciesDto) {
    return this.escalation.replacePolicies(input);
  }

  @Post('notifications/:notificationId/acknowledge')
  @Permissions('patrols:monitor')
  acknowledge(
    @Param() params: NotificationParam,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.escalation.acknowledge(params.notificationId, request.user.sub);
  }

  @Post('events/:eventId/false-alarm')
  @Permissions('patrols:execute')
  falseAlarm(
    @Param() params: EventParam,
    @Body() input: FalseAlarmDto,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.escalation.cancelAsFalseAlarm(params.eventId, request.user.sub, input.reason);
  }
}
