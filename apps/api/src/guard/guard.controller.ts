import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { GuardService } from './guard.service';

@Controller('guard')
@Roles('GUARDIA')
@TenantScope()
export class GuardController {
  constructor(private readonly guardService: GuardService) {}

  @Get('home')
  home(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.guardService.getHome(request.user.sub);
  }

  @Post('patrols/:patrolId/start')
  start(
    @Param('patrolId') patrolId: string,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.startPatrol(patrolId, request.user.sub);
  }
}
