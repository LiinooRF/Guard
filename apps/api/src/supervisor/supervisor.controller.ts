import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { CreatePatrolDto } from './dto/create-patrol.dto';
import { CreateRouteDto, UpdateRouteDto } from './dto/create-route.dto';
import { AssignShiftDto, CreateShiftDto } from './dto/create-shift.dto';
import { UpdateActiveDto } from '../admin/dto/update-active.dto';
import { SupervisorService } from './supervisor.service';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class RouteParam {
  @IsUUID()
  routeId!: string;
}

class ShiftParam {
  @IsUUID()
  shiftId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('supervisor')
@TenantScope()
export class SupervisorController {
  constructor(private readonly supervisor: SupervisorService) {}

  @Get('route-editor/sites')
  @Permissions('routes:manage')
  routeEditorSites(@Req() request: Autenticado) {
    return this.supervisor.routeEditorSites(request.user.sub);
  }

  @Get('sites/:siteId/routes')
  @Permissions('routes:manage')
  listRoutes(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.supervisor.listRoutes(params.siteId, request.user.sub);
  }

  @Post('sites/:siteId/routes')
  @Permissions('routes:manage')
  createRoute(
    @Param() params: SiteParam,
    @Body() input: CreateRouteDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.createRoute(params.siteId, request.user.sub, input);
  }

  @Put('routes/:routeId')
  @Permissions('routes:manage')
  updateRoute(
    @Param() params: RouteParam,
    @Body() input: UpdateRouteDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.updateRoute(params.routeId, request.user.sub, input);
  }

  @Patch('routes/:routeId/active')
  @Permissions('routes:manage')
  setRouteActive(
    @Param() params: RouteParam,
    @Body() input: UpdateActiveDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.setRouteActive(params.routeId, request.user.sub, input.isActive);
  }

  @Post('routes/:routeId/patrols')
  @Permissions('shifts:manage')
  createPatrol(
    @Param() params: RouteParam,
    @Body() input: CreatePatrolDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.createPatrol(params.routeId, request.user.sub, input);
  }

  @Get('sites/:siteId/patrols')
  @Permissions('patrols:monitor')
  listPatrols(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.supervisor.listPatrols(params.siteId, request.user.sub);
  }

  @Get('sites/:siteId/shifts')
  @Permissions('shifts:manage')
  listShifts(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.supervisor.listShifts(params.siteId, request.user.sub);
  }

  @Post('sites/:siteId/shifts')
  @Permissions('shifts:manage')
  createShift(
    @Param() params: SiteParam,
    @Body() input: CreateShiftDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.createShift(params.siteId, request.user.sub, input);
  }

  @Post('shifts/:shiftId/assignments')
  @Permissions('shifts:manage')
  assignShift(
    @Param() params: ShiftParam,
    @Body() input: AssignShiftDto,
    @Req() request: Autenticado,
  ) {
    return this.supervisor.assignShift(params.shiftId, request.user.sub, input);
  }

  @Get('sites/:siteId/on-duty')
  @Permissions('patrols:monitor')
  onDutyNow(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.supervisor.onDutyNow(params.siteId, request.user.sub);
  }

  @Get('sites/:siteId/events')
  @Permissions('patrols:monitor')
  listEvents(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.supervisor.listEvents(params.siteId, request.user.sub);
  }
}
