import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { CreateScanDto } from './dto/create-scan.dto';
import { ReportEventDto } from './dto/report-event.dto';
import { ShiftMarkDto } from './dto/shift-mark.dto';
import { GuardService } from './guard.service';

@Controller('guard')
@TenantScope()
export class GuardController {
  constructor(private readonly guardService: GuardService) {}

  @Get('home')
  @Permissions('patrols:execute')
  home(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.guardService.getHome(request.user.sub);
  }

  @Post('patrols/:patrolId/start')
  @Permissions('patrols:execute')
  start(
    @Param('patrolId') patrolId: string,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.startPatrol(patrolId, request.user.sub);
  }

  @Post('patrols/:patrolId/scans')
  @Permissions('patrols:execute')
  scan(
    @Param('patrolId') patrolId: string,
    @Body() input: CreateScanDto,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.registerScan(patrolId, request.user.sub, input);
  }

  @Post('shift/start')
  @Permissions('patrols:execute')
  startShift(@Body() input: ShiftMarkDto, @Req() request: Request & { user: AuthenticatedUser }) {
    return this.guardService.startShift(request.user.sub, input);
  }

  @Post('shift/end')
  @Permissions('patrols:execute')
  endShift(@Body() input: ShiftMarkDto, @Req() request: Request & { user: AuthenticatedUser }) {
    return this.guardService.endShift(request.user.sub, input);
  }

  @Post('routes/:routeId/voluntary-patrol')
  @Permissions('patrols:execute')
  startVoluntaryPatrol(
    @Param('routeId') routeId: string,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.startVoluntaryPatrol(request.user.sub, routeId);
  }

  @Post('events')
  @Permissions('patrols:execute')
  reportEvent(
    @Body() input: ReportEventDto,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.reportEvent(request.user.sub, input);
  }

  /**
   * ¿Alguien recibio y acuso el evento de panico? (#125)
   *
   * Es la mitad que le falta al boton: apretarlo y no saber si llego deja al
   * guardia igual de solo que antes. Devuelve la ETIQUETA de quien acuso, nunca
   * su id — a el no le sirve un UUID y expone al otro sin motivo.
   */
  @Get('events/:eventId/acuse')
  @Permissions('patrols:execute')
  eventAcknowledgement(
    @Param('eventId') eventId: string,
    @Req() request: Request & { user: AuthenticatedUser },
  ) {
    return this.guardService.eventAcknowledgement(eventId, request.user.sub);
  }
}
