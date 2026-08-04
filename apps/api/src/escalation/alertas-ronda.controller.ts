import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AttendAlertDto, ListAlertsQueryDto } from './alertas-ronda.dto';
import { AlertasRondaService } from './alertas-ronda.service';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class AlertParam {
  @IsUUID()
  alertId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Alertas de ronda del supervisor (#98).
 *
 * Cuelga de `/supervisor` y no de `/escalation` porque es la MISMA bandeja de
 * trabajo que el resto del tablero (`/supervisor/sites/:siteId/patrols`,
 * `/events`, `/on-duty`): partirla en dos prefijos obligaria al panel a saber
 * que la ronda vencida vive en otro lado que la novedad. El codigo vive en
 * `escalation/` porque comparte el modelo de aviso y acuse con #126.
 *
 * `patrols:monitor` lo tiene SOLO el SUPERVISOR (ver ROLE_PERMISSIONS), y el
 * servicio ademas verifica que el recinto este ASIGNADO: el rol no alcanza.
 */
@Controller('supervisor')
@TenantScope()
export class AlertasRondaController {
  constructor(private readonly alertas: AlertasRondaService) {}

  @Get('sites/:siteId/alerts')
  @Permissions('patrols:monitor')
  listAlerts(
    @Param() params: SiteParam,
    @Query() query: ListAlertsQueryDto,
    @Req() request: Autenticado,
  ) {
    // Ausente = solo lo pendiente. La bandeja arranca con lo que hay que hacer.
    const soloPendientes = query.onlyPending === undefined ? true : query.onlyPending === 'true';
    return this.alertas.listar(params.siteId, request.user.sub, soloPendientes);
  }

  @Post('alerts/:alertId/attend')
  @Permissions('patrols:monitor')
  attendAlert(
    @Param() params: AlertParam,
    @Body() input: AttendAlertDto,
    @Req() request: Autenticado,
  ) {
    return this.alertas.atender(params.alertId, request.user.sub, input.comment);
  }
}
