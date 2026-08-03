import { IsISO8601, IsOptional } from 'class-validator';

export class UploadPhotoDto {
  /**
   * Hora de captura segun el dispositivo (EXIF/camara). La app (#67) garantiza
   * camara-nunca-galeria; este campo permite ademas detectar del lado servidor
   * una foto tomada mucho antes del escaneo.
   */
  @IsOptional()
  @IsISO8601()
  takenAtDevice?: string;
}
