import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Response } from 'express';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SiteSummaryQueryDto } from './dto/site-summary-query.dto';
import { ReportsService } from './reports.service';

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

class SiteParam {
  @IsUUID()
  siteId!: string;
}

@Controller('reports')
@TenantScope()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('patrols/:patrolId')
  @Permissions('reports:read')
  async patrolReport(
    @Param() params: PatrolParam,
    @Res({ passthrough: false }) response: Response,
  ) {
    const informe = await this.reports.buildPatrolReport(params.patrolId);
    this.responderPdf(response, informe.filename, informe.pdf);
  }

  @Get('sites/:siteId')
  @Permissions('reports:read')
  async siteSummary(
    @Param() params: SiteParam,
    @Query() query: SiteSummaryQueryDto,
    @Res({ passthrough: false }) response: Response,
  ) {
    const informe = await this.reports.buildSiteSummary(params.siteId, query.from, query.to);
    this.responderPdf(response, informe.filename, informe.pdf);
  }

  /**
   * Con `passthrough: false` Nest deja la respuesta en nuestras manos: hay que
   * terminarla aca. Las excepciones lanzadas antes de escribir siguen pasando
   * por el exception filter global (404, 400, 403 en JSON como siempre).
   */
  private responderPdf(response: Response, filename: string, pdf: Buffer): void {
    response
      .status(HttpStatus.OK)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdf.length),
      })
      .end(pdf);
  }
}
