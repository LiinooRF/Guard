import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { PushBatchDto } from './dto/push-batch.dto';
import {
  LateScanParamDto,
  LateScansQueryDto,
  ReviewLateScanDto,
} from './dto/review-late-scan.dto';
import { SyncConflictsService } from './sync-conflicts.service';
import { SyncService } from './sync.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Sincronizacion offline del guardia (#14) y resolucion de conflictos (#73).
 *
 * El guardia solo sincroniza LO SUYO: el id sale de la sesion, nunca del cuerpo
 * del request. Las marcas atrasadas, en cambio, las revisa el SUPERVISOR, y por
 * eso esos dos endpoints piden `patrols:monitor` en vez de `patrols:execute`.
 * El recinto se verifica ademas contra supervisor_sites dentro del servicio:
 * tener el permiso no significa tener el recinto.
 */
@Controller('sync')
@TenantScope()
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly conflicts: SyncConflictsService,
  ) {}

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

  /**
   * Hora del servidor y ultima medicion del reloj de este guardia (#73). La app
   * lo consulta ANTES de salir a terreno: un telefono con la hora corrida se
   * arregla en 10 segundos si alguien avisa, y no se arregla nunca si nadie
   * avisa. No escribe medicion: consultar la hora no puede ensuciar la bitacora.
   */
  @Get('clock')
  @Permissions('patrols:execute')
  clock(@Req() request: Autenticado) {
    return this.sync.clockStatus(request.user.sub);
  }

  /** Bandeja de marcas atrasadas de un recinto del supervisor (#73). */
  @Get('late-scans')
  @Permissions('patrols:monitor')
  lateScans(@Query() query: LateScansQueryDto, @Req() request: Autenticado) {
    return this.conflicts.listarAtrasados(query.siteId, request.user.sub);
  }

  /** El supervisor deja escrito como se lee esa marca atrasada (#73). */
  @Post('late-scans/:id/review')
  @Permissions('patrols:monitor')
  reviewLateScan(
    @Param() params: LateScanParamDto,
    @Body() input: ReviewLateScanDto,
    @Req() request: Autenticado,
  ) {
    return this.conflicts.revisar(params.id, request.user.sub, input.decision, input.note);
  }
}
