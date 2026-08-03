import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { UploadPhotoDto } from './dto/upload-photo.dto';
import { EvidenceService, type FotoSubida } from './evidence.service';

class ScanParam {
  @IsUUID()
  scanId!: string;
}

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Techo tecnico del interceptor, solo anti-DoS: evita bufferizar subidas
 * gigantes. El maximo REAL por tenant es photoMaxSizeMB (rules.ts) y lo aplica
 * el servicio; este valor coincide con el tope del schema (50 MB).
 */
const TECHO_FOTO_BYTES = 50 * 1024 * 1024;

@Controller('evidence')
@TenantScope()
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Post('scans/:scanId/photos')
  @Permissions('patrols:execute')
  @UseInterceptors(FileInterceptor('foto', { limits: { fileSize: TECHO_FOTO_BYTES } }))
  uploadPhoto(
    @Param() params: ScanParam,
    @UploadedFile() foto: FotoSubida | undefined,
    @Body() input: UploadPhotoDto,
    @Req() request: Autenticado,
  ) {
    if (!foto) throw new BadRequestException('Falta el archivo en el campo "foto"');
    return this.evidence.storePhoto(params.scanId, request.user.sub, foto, input.takenAtDevice);
  }

  @Get('patrols/:patrolId/photos')
  @Permissions('reports:read')
  listPatrolPhotos(@Param() params: PatrolParam, @Req() request: Autenticado) {
    return this.evidence.listByPatrol(params.patrolId, request.user);
  }
}
