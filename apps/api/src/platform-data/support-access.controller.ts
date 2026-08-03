import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { OpenSupportAccessDto } from './dto/support-access.dto';
import { SupportAccessService } from './support-access.service';

class AccessParam {
  @IsUUID()
  supportAccessId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Sin @TenantScope: el SUPERADMIN vive fuera del contexto de empresa. Abrir el
 * acceso es una operacion de plataforma; USARLO es lo que entra al tenant, con
 * la cabecera x-support-access-id que lee el interceptor.
 */
@Controller('platform/support-access')
export class SupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Get()
  @Permissions('platform:support:access')
  active(@Req() request: Autenticado) {
    return this.support.active(request.user.sub);
  }

  @Post()
  @Permissions('platform:support:access')
  open(@Body() input: OpenSupportAccessDto, @Req() request: Autenticado) {
    return this.support.open(request.user.sub, input);
  }

  @Delete(':supportAccessId')
  @Permissions('platform:support:access')
  close(@Param() params: AccessParam, @Req() request: Autenticado) {
    return this.support.close(request.user.sub, params.supportAccessId);
  }
}
