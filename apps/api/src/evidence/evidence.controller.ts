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
import { EventPhotosService } from './event-photos.service';
import { EvidenceService } from './evidence.service';
import type { FotoSubida } from './photo-validation';

class ScanParam {
  @IsUUID()
  scanId!: string;
}

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

class EventParam {
  @IsUUID()
  eventId!: string;
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
  constructor(
    private readonly evidence: EvidenceService,
    private readonly eventPhotos: EventPhotosService,
  ) {}

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

  /**
   * La foto del libro de novedades (#122). Va en peticion aparte de la novedad
   * —no en el mismo POST— porque el reporte pesa bytes y la foto pesa megas: si
   * fueran uno solo, una subida cortada en terreno se llevaria tambien el
   * reporte, que es la parte que importa.
   */
  @Post('events/:eventId/photos')
  @Permissions('patrols:execute')
  @UseInterceptors(FileInterceptor('foto', { limits: { fileSize: TECHO_FOTO_BYTES } }))
  uploadEventPhoto(
    @Param() params: EventParam,
    @UploadedFile() foto: FotoSubida | undefined,
    @Body() input: UploadPhotoDto,
    @Req() request: Autenticado,
  ) {
    if (!foto) throw new BadRequestException('Falta el archivo en el campo "foto"');
    return this.eventPhotos.store(params.eventId, request.user.sub, foto, input.takenAtDevice);
  }

  @Get('events/:eventId/photos')
  @Permissions('reports:read')
  listEventPhotos(@Param() params: EventParam, @Req() request: Autenticado) {
    return this.eventPhotos.listByEvent(params.eventId, request.user);
  }
}
