import { Controller, Get, HttpStatus, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ExcelExportQueryDto } from './excel-export.dto';
import { ExcelExportService } from './excel-export.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Descarga de la exportacion a Excel (#136).
 *
 * Controlador aparte de ReportsController y no un metodo mas: el PDF y el
 * Excel tienen consumidores distintos (el cliente final y el administrador) y
 * mantenerlos separados evita que un cambio en el informe del cliente toque el
 * camino de la planilla.
 */
@Controller('reports')
@TenantScope()
export class ExcelExportController {
  constructor(private readonly excel: ExcelExportService) {}

  /**
   * Va en dos fases porque no se puede volver atras despues del primer byte:
   * primero se resuelven datos y permisos —404, 403 y 400 salen en JSON como
   * siempre— y recien despues se abre la respuesta.
   *
   * Sin `Content-Length` a proposito: el largo no se conoce hasta terminar de
   * comprimir, y conocerlo obligaria a armar el libro entero en memoria.
   */
  @Get('excel')
  @Permissions('reports:read')
  async exportarExcel(
    @Query() query: ExcelExportQueryDto,
    @Req() request: Autenticado,
    @Res({ passthrough: false }) response: Response,
  ) {
    const libro = await this.excel.construir(query, {
      userId: request.user.sub,
      role: request.user.role,
    });

    response.status(HttpStatus.OK).set({
      'Content-Type': ExcelExportService.contentType,
      'Content-Disposition': `attachment; filename="${libro.filename}"`,
    });
    await this.excel.escribir(libro, response);
    response.end();
  }
}
