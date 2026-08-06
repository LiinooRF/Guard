import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import {
  DIAS_TRAZA_POR_DEFECTO,
  TrazaDiariaQuery,
  TrazaPatrolParam,
  TrazaSiteParam,
} from './traza-metricas.dto';
import { TrazaMetricasService } from './traza-metricas.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Traza del recorrido como dato (#134).
 *
 * Controlador aparte de GeoController y de GpsPolicyController a proposito:
 * aquel resuelve la traza cruda y el consentimiento (#15), el otro la POLITICA
 * de ubicacion (#77) y este las METRICAS del recorrido. Comparten el prefijo
 * `geo` y ninguna ruta se pisa — `patrols/:patrolId/track` sigue siendo la serie
 * de puntos, `patrols/:patrolId/track-summary` es el analisis.
 *
 * `reports:read` y no `patrols:monitor`: son numeros de informe (distancia,
 * cobertura, tiempo detenido) y el ADMIN, que es quien configura la frecuencia
 * de muestreo, tiene que poder verlos. El SUPERVISOR queda igual limitado a sus
 * recintos asignados, lo que se verifica en el servicio y no aca.
 *
 * Todo el controlador es tenant-scoped: no hay nada que un SUPERADMIN —que por
 * definicion no tiene tenant— tenga que hacer con la traza de una ronda.
 */
@Controller('geo')
@TenantScope()
export class TrazaMetricasController {
  constructor(private readonly traza: TrazaMetricasService) {}

  /** Distancia, huecos de cobertura y tiempo detenido de una ronda. */
  @Get('patrols/:patrolId/track-summary')
  @Permissions('reports:read')
  patrolTrackSummary(@Param() params: TrazaPatrolParam, @Req() request: Autenticado) {
    return this.traza.patrolTrackSummary(params.patrolId, request.user);
  }

  /** Lo mismo agregado por dia del recinto, para la pantalla de estadisticas. */
  @Get('sites/:siteId/track-daily')
  @Permissions('reports:read')
  siteTrackDaily(
    @Param() params: TrazaSiteParam,
    @Query() query: TrazaDiariaQuery,
    @Req() request: Autenticado,
  ) {
    return this.traza.siteTrackDaily(
      params.siteId,
      query.days ?? DIAS_TRAZA_POR_DEFECTO,
      request.user,
    );
  }
}
