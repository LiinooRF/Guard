import { Controller, Get, HttpStatus, Param, Query, Req, Res } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SiteSummaryQueryDto } from './dto/site-summary-query.dto';
import { PatrolReportService } from './patrol-report.service';
import { ReportsService } from './reports.service';

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

class SiteParam {
  @IsUUID()
  siteId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('reports')
@TenantScope()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    // No se llama `patrolReport`: ese es el nombre del handler y el metodo de
    // la clase no puede chocar con la propiedad inyectada.
    private readonly informeRonda: PatrolReportService,
  ) {}

  /**
   * El informe de la ronda se sirve por STREAMING: los bytes salen hacia el
   * cliente mientras se dibuja, en vez de armar el PDF completo en memoria y
   * despues escribirlo. Con el anexo fotografico de una ronda larga la
   * diferencia es entre decenas de MB por descarga y una foto a la vez.
   *
   * Va en dos fases porque no se puede volver atras despues del primer byte:
   * primero se resuelven datos y permisos (404/403 salen en JSON como siempre)
   * y recien despues se abre la respuesta.
   */
  @Get('patrols/:patrolId')
  @Permissions('reports:read')
  async patrolReport(
    @Param() params: PatrolParam,
    @Req() request: Autenticado,
    @Res({ passthrough: false }) response: Response,
  ) {
    const modelo = await this.informeRonda.buildModel(params.patrolId, {
      requester: request.user,
    });

    // Sin Content-Length a proposito: el largo no se conoce hasta terminar de
    // dibujar, y conocerlo exigiria justamente bufferizar el PDF entero.
    response.status(HttpStatus.OK).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${modelo.filename}"`,
    });
    await this.informeRonda.render(modelo, response);
  }

  @Get('sites/:siteId')
  @Permissions('reports:read')
  async siteSummary(
    @Param() params: SiteParam,
    @Query() query: SiteSummaryQueryDto,
    @Req() request: Autenticado,
    @Res({ passthrough: false }) response: Response,
  ) {
    const informe = await this.reports.buildSiteSummary(
      params.siteId,
      query.from,
      query.to,
      request.user,
    );
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
