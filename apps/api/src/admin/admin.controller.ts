import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsUUID } from 'class-validator';

import { Roles } from '../auth/decorators/roles.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AdminService } from './admin.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { CreateTenantUserDto } from './dto/create-user.dto';
import { UpdateActiveDto } from './dto/update-active.dto';

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

class AssignmentDto {
  @IsBoolean()
  assigned!: boolean;
}

@Controller('admin')
@Roles('ADMIN')
@TenantScope()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  listUsers() {
    return this.admin.listUsers();
  }

  @Post('users')
  createUser(@Body() input: CreateTenantUserDto) {
    return this.admin.createUser(input);
  }

  @Patch('users/:userId/active')
  setUserActive(@Param() params: UserParam, @Body() input: UpdateActiveDto) {
    return this.admin.setUserActive(params.userId, input.isActive);
  }

  @Delete('users/:userId/sessions')
  revokeUserSessions(@Param() params: UserParam) {
    return this.admin.revokeUserSessions(params.userId);
  }

  @Get('sites')
  listSites() {
    return this.admin.listSites();
  }

  @Post('sites')
  createSite(@Body() input: CreateSiteDto) {
    return this.admin.createSite(input);
  }

  @Patch('sites/:siteId/active')
  setSiteActive(@Param() params: SiteParam, @Body() input: UpdateActiveDto) {
    return this.admin.setSiteActive(params.siteId, input.isActive);
  }

  @Patch('users/:userId/sites/:siteId')
  setSupervisorSite(
    @Param() params: AssignmentParam,
    @Body() input: AssignmentDto,
  ) {
    return this.admin.setSupervisorSite(params.userId, params.siteId, input.assigned);
  }
}
