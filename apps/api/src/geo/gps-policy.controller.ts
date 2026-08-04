import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ReportGpsPermissionDto } from './dto/gps-permission.dto';
import {
  DIAS_COBERTURA_POR_DEFECTO,
  GeoPatrolParam,
  GeoSiteParam,
  GpsCoverageQuery,
  GpsPolicyQuery,
} from './dto/gps-query.dto';
import { GpsPolicyService } from './gps-policy.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * GPS obligatorio configurable (#77).
 *
 * Controlador aparte de GeoController a proposito: aquel resuelve la traza y el
 * consentimiento (#15, #134) y este la POLITICA de ubicacion. Comparten el
 * prefijo `geo` y ninguna ruta se pisa.
 *
 * Todo el modulo es tenant-scoped, a diferencia de los endpoints de
 * consentimiento: aca no hay nada que un SUPERADMIN —que por definicion no tiene
 * tenant— tenga que hacer.
 */
@Controller('geo')
@TenantScope()
export class GpsPolicyController {
  constructor(private readonly gps: GpsPolicyService) {}

  /**
   * Politica vigente para el guardia. La app la pide al abrir y al iniciar cada
   * ronda: por eso un cambio del admin aplica sin actualizar la app.
   */
  @Get('policy')
  @Permissions('patrols:execute')
  policy(@Query() query: GpsPolicyQuery, @Req() request: Autenticado) {
    return this.gps.policy(request.user.sub, query.siteId ?? null);
  }

  /** El telefono informa como quedo su permiso de ubicacion del sistema. */
  @Post('permission')
  @Permissions('patrols:execute')
  reportPermission(@Body() input: ReportGpsPermissionDto, @Req() request: Autenticado) {
    return this.gps.reportPermission(request.user.sub, input);
  }

  /**
   * Chequeo previo al arranque: el telefono manda su estado y el servidor
   * responde si la ronda puede iniciarse. Responde 200 aunque este bloqueada,
   * con el motivo, para que la app muestre la pantalla que corresponde.
   */
  @Post('patrols/:patrolId/gps-check')
  @Permissions('patrols:execute')
  gpsCheck(
    @Param() params: GeoPatrolParam,
    @Body() input: ReportGpsPermissionDto,
    @Req() request: Autenticado,
  ) {
    return this.gps.patrolStartCheck(request.user.sub, params.patrolId, input);
  }

  /**
   * Consumo de bateria de la ronda, medido con la traza.
   *
   * `reports:read` (ADMIN y SUPERVISOR) y no `patrols:monitor`: el admin es
   * quien decide la frecuencia de muestreo y quien tiene que ver lo que esa
   * decision le cuesta a los telefonos. El supervisor queda igual limitado a
   * sus recintos asignados.
   */
  @Get('patrols/:patrolId/battery')
  @Permissions('reports:read')
  patrolBattery(@Param() params: GeoPatrolParam, @Req() request: Autenticado) {
    return this.gps.patrolBattery(params.patrolId, request.user);
  }

  /** Rondas con y sin recorrido registrado, por dia del recinto. */
  @Get('sites/:siteId/gps-coverage')
  @Permissions('reports:read')
  siteGpsCoverage(
    @Param() params: GeoSiteParam,
    @Query() query: GpsCoverageQuery,
    @Req() request: Autenticado,
  ) {
    return this.gps.siteGpsCoverage(
      params.siteId,
      query.days ?? DIAS_COBERTURA_POR_DEFECTO,
      request.user,
    );
  }
}
