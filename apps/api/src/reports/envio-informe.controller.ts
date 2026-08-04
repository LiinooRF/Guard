import { Controller, Get, Param, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { EnvioInformeService } from './envio-informe.service';

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Consulta del envio automatico del informe (#86).
 *
 * Va en su propio controlador y no dentro de ReportsController porque este
 * carril entero (cola, worker, bitacora) se registra como modulo aparte: el
 * envio automatico se puede desplegar, apagar o mover a otro proceso sin tocar
 * la descarga de informes desde el panel.
 *
 * Es de SOLO LECTURA a proposito. No existe "reenviar": el envio es automatico y
 * su idempotencia esta en el nucleo del issue. Si alguien necesita el PDF otra
 * vez, lo descarga con GET /api/reports/patrols/:patrolId, que ya existe.
 */
@Controller('reports')
@TenantScope()
export class EnvioInformeController {
  constructor(private readonly envio: EnvioInformeService) {}

  /**
   * A quien se le despacho el informe de esta ronda y si llevaba el PDF.
   *
   * El SUPERVISOR solo ve rondas de sus recintos asignados; el chequeo esta en
   * el servicio, porque el permiso `reports:read` por si solo no alcanza.
   */
  @Get('patrols/:patrolId/envio')
  @Permissions('reports:read')
  async estadoEnvio(@Param() params: PatrolParam, @Req() request: Autenticado) {
    return this.envio.estadoDeEnvio(params.patrolId, request.user);
  }
}
