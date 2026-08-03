import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsUUID } from 'class-validator';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AdminService } from './admin.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { CreateTenantUserDto } from './dto/create-user.dto';
import { UpdateActiveDto } from './dto/update-active.dto';
import { UpdateAuthPolicyDto } from './dto/update-auth-policy.dto';

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
@TenantScope()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @Permissions('tenant:users:manage')
  listUsers() {
    return this.admin.listUsers();
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

  @Patch('sites/:siteId/active')
  @Permissions('tenant:sites:manage')
  setSiteActive(@Param() params: SiteParam, @Body() input: UpdateActiveDto) {
    return this.admin.setSiteActive(params.siteId, input.isActive);
  }

  @Patch('users/:userId/sites/:siteId')
  @Permissions('tenant:users:manage', 'tenant:sites:manage')
  setSupervisorSite(
    @Param() params: AssignmentParam,
    @Body() input: AssignmentDto,
  ) {
    return this.admin.setSupervisorSite(params.userId, params.siteId, input.assigned);
  }
}
