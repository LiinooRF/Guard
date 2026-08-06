import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ChartQueryDto, EvolutionQueryDto, TopQueryDto } from './dto/chart-query.dto';
import { StatsChartsService, type ChartScope } from './stats-charts.service';

/**
 * Series agregadas para las graficas de informes (#89).
 *
 * Ruta propia (`/api/stats/charts`) y no bajo `/api/admin`: estas graficas las
 * ve tambien el SUPERVISOR, acotadas a sus recintos. Por eso el permiso es
 * `reports:read` —que tienen ADMIN y SUPERVISOR— y no `tenant:stats:read`, que
 * es exclusivo del ADMIN.
 *
 * Sin decorador un endpoint queda DENEGADO por el guard global; los cinco
 * declaran permiso y `@TenantScope()` a nivel de clase.
 */
@Controller('stats/charts')
@TenantScope()
export class StatsChartsController {
  constructor(private readonly charts: StatsChartsService) {}

  @Get('compliance-by-site')
  @Permissions('reports:read')
  complianceBySite(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query() query: ChartQueryDto,
  ) {
    return this.charts.complianceBySite(this.alcance(request), query);
  }

  @Get('evolution')
  @Permissions('reports:read')
  evolution(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query() query: EvolutionQueryDto,
  ) {
    return this.charts.evolution(this.alcance(request), query);
  }

  @Get('missed-checkpoints')
  @Permissions('reports:read')
  missedCheckpoints(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query() query: TopQueryDto,
  ) {
    return this.charts.missedCheckpoints(this.alcance(request), query);
  }

  @Get('guard-ranking')
  @Permissions('reports:read')
  guardRanking(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query() query: TopQueryDto,
  ) {
    return this.charts.guardRanking(this.alcance(request), query);
  }

  /**
   * Cumplimiento por ruta (#99). Lo pide el panel del supervisor con el
   * `siteId` del recinto que esta mirando: las rutas de dos recintos distintos
   * no se comparan entre si. Sin `siteId` responde igual, mezclando los
   * recintos que el alcance deje ver.
   */
  @Get('compliance-by-route')
  @Permissions('reports:read')
  complianceByRoute(
    @Req() request: Request & { user: AuthenticatedUser },
    @Query() query: TopQueryDto,
  ) {
    return this.charts.complianceByRoute(this.alcance(request), query);
  }

  /** El alcance sale de la SESION, nunca de la query string. */
  private alcance(request: Request & { user: AuthenticatedUser }): ChartScope {
    return { userId: request.user.sub, role: request.user.role };
  }
}
