import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { PushBatchDto } from './dto/push-batch.dto';
import { SyncService } from './sync.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Sincronizacion offline del guardia (#14). El guardia solo sincroniza LO SUYO:
 * el id sale de la sesion, nunca del cuerpo del request.
 */
@Controller('sync')
@TenantScope()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @Permissions('patrols:execute')
  push(@Body() input: PushBatchDto, @Req() request: Autenticado) {
    return this.sync.pushBatch(request.user.sub, input);
  }

  @Get('status')
  @Permissions('patrols:execute')
  status(@Req() request: Autenticado) {
    return this.sync.syncStatus(request.user.sub);
  }
}
