import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { IsBoolean, IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AdminService } from './admin.service';
import { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import { CreateSiteDto } from './dto/create-site.dto';
import { CreateTenantUserDto, UpdateTenantUserDto } from './dto/create-user.dto';
import { ImportCheckpointsDto } from './dto/import-checkpoints.dto';
import { UpdateActiveDto } from './dto/update-active.dto';
import { UpdateAuthPolicyDto } from './dto/update-auth-policy.dto';
import { RegisterTagDto, ResolveTagQuery } from './dto/register-tag.dto';
import {
  ReplaceSiteBusinessHoursDto,
  ReplaceSiteHolidaysDto,
} from './dto/site-calendar.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { PhotoOverrideDto, UpdateCheckpointDto } from './dto/update-checkpoint.dto';

class UserParam {
  @IsUUID()
  userId!: string;
}

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class AssignmentParam extends UserParam {
  @IsUUID()
  siteId!: string;
}

class CheckpointParam {
  @IsUUID()
  checkpointId!: string;
}

class TagParam {
  @IsUUID()
  tagId!: string;
}

class AssignmentDto {
  @IsBoolean()
  assigned!: boolean;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('admin')
@TenantScope()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @Permissions('tenant:users:manage')
  listUsers() {
    return this.admin.listUsers();
  }

  @Get('quota')
  @Permissions('tenant:users:manage')
  getQuota() {
    return this.admin.getTenantQuota();
  }

  @Get('security/policy')
  @Permissions('tenant:security:manage')
  getAuthPolicy() {
    return this.admin.getAuthPolicy();
  }

  @Patch('security/policy')
  @Permissions('tenant:security:manage')
  updateAuthPolicy(@Body() input: UpdateAuthPolicyDto) {
    return this.admin.updateAuthPolicy(input);
  }

  @Get('security/events')
  @Permissions('tenant:security:manage')
  securityEvents() {
    return this.admin.listSecurityEvents();
  }

  @Post('users')
  @Permissions('tenant:users:manage')
  createUser(@Body() input: CreateTenantUserDto) {
    return this.admin.createUser(input);
  }

  @Patch('users/:userId')
  @Permissions('tenant:users:manage')
  updateUser(@Param() params: UserParam, @Body() input: UpdateTenantUserDto) {
    return this.admin.updateUser(params.userId, input);
  }

  @Patch('users/:userId/active')
  @Permissions('tenant:users:manage')
  setUserActive(@Param() params: UserParam, @Body() input: UpdateActiveDto) {
    return this.admin.setUserActive(params.userId, input.isActive);
  }

  @Delete('users/:userId/sessions')
  @Permissions('tenant:users:manage')
  revokeUserSessions(@Param() params: UserParam) {
    return this.admin.revokeUserSessions(params.userId);
  }

  @Get('sites')
  @Permissions('tenant:sites:manage')
  listSites() {
    return this.admin.listSites();
  }

  @Post('sites')
  @Permissions('tenant:sites:manage')
  createSite(@Body() input: CreateSiteDto) {
    return this.admin.createSite(input);
  }

  @Patch('sites/:siteId')
  @Permissions('tenant:sites:manage')
  updateSite(@Param() params: SiteParam, @Body() input: UpdateSiteDto) {
    return this.admin.updateSite(params.siteId, input);
  }

  @Patch('sites/:siteId/active')
  @Permissions('tenant:sites:manage')
  setSiteActive(@Param() params: SiteParam, @Body() input: UpdateActiveDto) {
    return this.admin.setSiteActive(params.siteId, input.isActive);
  }

  @Get('sites/:siteId/business-hours')
  @Permissions('tenant:sites:manage')
  listBusinessHours(@Param() params: SiteParam) {
    return this.admin.listBusinessHours(params.siteId);
  }

  @Put('sites/:siteId/business-hours')
  @Permissions('tenant:sites:manage')
  replaceBusinessHours(
    @Param() params: SiteParam,
    @Body() input: ReplaceSiteBusinessHoursDto,
  ) {
    return this.admin.replaceBusinessHours(params.siteId, input.hours);
  }

  @Get('sites/:siteId/holidays')
  @Permissions('tenant:sites:manage')
  listHolidays(@Param() params: SiteParam) {
    return this.admin.listHolidays(params.siteId);
  }

  @Put('sites/:siteId/holidays')
  @Permissions('tenant:sites:manage')
  replaceHolidays(@Param() params: SiteParam, @Body() input: ReplaceSiteHolidaysDto) {
    return this.admin.replaceHolidays(params.siteId, input.holidays);
  }

  @Patch('users/:userId/sites/:siteId')
  @Permissions('tenant:users:manage', 'tenant:sites:manage')
  setSupervisorSite(
    @Param() params: AssignmentParam,
    @Body() input: AssignmentDto,
  ) {
    return this.admin.setSupervisorSite(params.userId, params.siteId, input.assigned);
  }

  @Get('sites/:siteId/checkpoints')
  @Permissions('tenant:sites:manage')
  listCheckpoints(@Param() params: SiteParam) {
    return this.admin.listCheckpoints(params.siteId);
  }

  // El actor de las escrituras de terreno sale SIEMPRE de `request.user.sub`
  // (el token), nunca del cuerpo ni de la URL: es lo que queda en audit_log.
  // Estas rutas siguen siendo del ADMIN y operan sobre el tenant entero — el
  // SUPERVISOR entra por PuntosSupervisorController, acotado a sus recintos.
  @Post('sites/:siteId/checkpoints')
  @Permissions('tenant:sites:manage')
  createCheckpoint(
    @Param() params: SiteParam,
    @Body() input: CreateCheckpointDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.createCheckpoint(params.siteId, input, { actorId: request.user.sub });
  }

  @Post('sites/:siteId/checkpoints/import')
  @Permissions('tenant:sites:manage')
  importCheckpoints(
    @Param() params: SiteParam,
    @Body() input: ImportCheckpointsDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.importCheckpoints(params.siteId, input.checkpoints, {
      actorId: request.user.sub,
    });
  }

  @Patch('checkpoints/:checkpointId')
  @Permissions('tenant:sites:manage')
  updateCheckpoint(
    @Param() params: CheckpointParam,
    @Body() input: UpdateCheckpointDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.updateCheckpoint(params.checkpointId, input, { actorId: request.user.sub });
  }

  @Patch('checkpoints/:checkpointId/photo')
  @Permissions('tenant:sites:manage')
  setCheckpointPhoto(
    @Param() params: CheckpointParam,
    @Body() input: PhotoOverrideDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.setCheckpointPhoto(params.checkpointId, input.requiresPhoto, {
      actorId: request.user.sub,
    });
  }

  @Patch('checkpoints/:checkpointId/active')
  @Permissions('tenant:sites:manage')
  setCheckpointActive(
    @Param() params: CheckpointParam,
    @Body() input: UpdateActiveDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.setCheckpointActive(params.checkpointId, input.isActive, {
      actorId: request.user.sub,
    });
  }

  @Get('checkpoints/:checkpointId/tags')
  @Permissions('tenant:sites:manage')
  listTags(@Param() params: CheckpointParam) {
    return this.admin.listTags(params.checkpointId);
  }

  @Post('checkpoints/:checkpointId/tags')
  @Permissions('tenant:sites:manage')
  registerTag(
    @Param() params: CheckpointParam,
    @Body() input: RegisterTagDto,
    @Req() request: Autenticado,
  ) {
    return this.admin.registerTag(params.checkpointId, input, { actorId: request.user.sub });
  }

  @Delete('tags/:tagId')
  @Permissions('tenant:sites:manage')
  retireTag(@Param() params: TagParam, @Req() request: Autenticado) {
    return this.admin.retireTag(params.tagId, { actorId: request.user.sub });
  }

  @Get('tags/resolve')
  @Permissions('tenant:sites:manage')
  resolveTag(@Query() query: ResolveTagQuery) {
    return this.admin.resolveTag(query.uid);
  }
}
