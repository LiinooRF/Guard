import { Controller, Get, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { QrService } from './qr.service';

class CheckpointParam {
  @IsUUID()
  checkpointId!: string;
}

class SiteParam {
  @IsUUID()
  siteId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('qr')
@TenantScope()
export class QrController {
  constructor(private readonly qr: QrService) {}

  @Post('checkpoints/:checkpointId')
  @Permissions('tenant:sites:manage')
  issueCheckpointQr(@Param() params: CheckpointParam, @Req() request: Autenticado) {
    return this.qr.issueForCheckpoint(params.checkpointId, request.user.sub);
  }

  @Get('sites/:siteId/sheet')
  @Permissions('tenant:sites:manage')
  async siteSheet(
    @Param() params: SiteParam,
    @Res({ passthrough: false }) response: Response,
  ) {
    const planilla = await this.qr.sheetPdf(params.siteId);
    // Con `passthrough: false` la respuesta queda en nuestras manos; las
    // excepciones lanzadas antes de escribir siguen pasando por el filtro global.
    response
      .status(HttpStatus.OK)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${planilla.filename}"`,
        'Content-Length': String(planilla.pdf.length),
        'X-Qr-Labels': String(planilla.labels),
        'X-Qr-Missing': String(planilla.missing),
      })
      .end(planilla.pdf);
  }
}
