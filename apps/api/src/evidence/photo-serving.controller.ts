import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { IsNumberString, IsString, IsUUID, Matches } from 'class-validator';
import type { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { PhotoServingService } from './photo-serving.service';

class PhotoParam {
  @IsUUID()
  photoId!: string;
}

class SignedPhotoQuery {
  @IsNumberString()
  exp!: string;

  @IsUUID()
  tenant!: string;

  // Solo la forma; que la firma sea LA correcta lo decide el HMAC.
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sig!: string;
}

/**
 * Los bytes de la evidencia fotografica (#69).
 *
 * Va en un controlador aparte de EvidenceController y no como un metodo mas
 * porque su politica es la contraria: aquel es @TenantScope() completo, y este
 * no puede serlo. La autorizacion la da la FIRMA del enlace, y el contexto de
 * tenant lo pone el servicio desde el tenant que viene firmado — un
 * @TenantScope() heredado exigiria una sesion que este camino no tiene.
 *
 * Esta es la unica ruta que entrega los archivos: no hay directorio estatico ni
 * ruta adivinable hacia el volumen de evidencia.
 */
@Controller('evidence')
export class PhotoServingController {
  constructor(private readonly photoServing: PhotoServingService) {}

  @Get('photos/:photoId')
  @Public()
  @SkipTenantContext()
  async servePhoto(
    @Param() params: PhotoParam,
    @Query() query: SignedPhotoQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    const foto = await this.photoServing.serveSigned(
      params.photoId,
      query.tenant,
      query.exp,
      query.sig,
    );
    response.setHeader('Content-Type', foto.mimeType);
    // Cache privada y corta, atada a la vigencia del enlace: la evidencia no
    // puede quedar en una cache compartida ni sobrevivir a la firma.
    response.setHeader('Cache-Control', 'private, max-age=300, no-transform');
    response.setHeader('ETag', `"${foto.sha256}"`);
    return new StreamableFile(foto.buffer);
  }
}
