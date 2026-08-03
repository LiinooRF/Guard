import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { GenerateScheduleDto, PreviewScheduleQueryDto } from './dto/generate-schedule.dto';
import { ReplaceShiftPatternsDto } from './dto/shift-pattern.dto';
import { SchedulingService } from './scheduling.service';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class ShiftParam {
  @IsUUID()
  shiftId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('scheduling')
@TenantScope()
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  /** Que rondas se generarian ese dia. No escribe: es la pantalla de confirmar. */
  @Get('sites/:siteId/preview')
  @Permissions('shifts:manage')
  preview(
    @Param() params: SiteParam,
    @Query() query: PreviewScheduleQueryDto,
    @Req() request: Autenticado,
  ) {
    return this.scheduling.previewDay(params.siteId, query.date, request.user.sub);
  }

  /**
   * Punto de entrada unico de la generacion: hoy lo llama el supervisor y
   * mañana lo llamara el job de BullMQ con el mismo servicio. Ver INTEGRACION.md
   * — el cron NO se implementa aca a proposito.
   */
  @Post('generate')
  @Permissions('shifts:manage')
  generate(@Body() input: GenerateScheduleDto, @Req() request: Autenticado) {
    return this.scheduling.generateForDate(input, {
      kind: 'supervisor',
      supervisorId: request.user.sub,
    });
  }

  @Get('shifts/:shiftId/patterns')
  @Permissions('shifts:manage')
  listPatterns(@Param() params: ShiftParam, @Req() request: Autenticado) {
    return this.scheduling.listPatterns(params.shiftId, request.user.sub);
  }

  /** Reemplaza el set completo de patrones del turno (#132). */
  @Put('shifts/:shiftId/patterns')
  @Permissions('shifts:manage')
  replacePatterns(
    @Param() params: ShiftParam,
    @Body() input: ReplaceShiftPatternsDto,
    @Req() request: Autenticado,
  ) {
    return this.scheduling.replacePatterns(params.shiftId, request.user.sub, input);
  }
}
