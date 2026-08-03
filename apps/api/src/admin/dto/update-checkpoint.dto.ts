import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateCheckpointDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsIn(['normal', 'acceso_critico'])
  kind?: 'normal' | 'acceso_critico';

  @IsOptional()
  @IsInt()
  @Min(0)
  suggestedOrder?: number;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;
}

/**
 * Endpoint dedicado porque el override es tri-estado: `true` y `false` fuerzan
 * la foto en cualquier direccion, `null` vuelve a la regla del tenant. Un PATCH
 * generico no distingue "no tocar" de "limpiar".
 */
export class PhotoOverrideDto {
  @ValidateIf((o: PhotoOverrideDto) => o.requiresPhoto !== null)
  @IsBoolean()
  requiresPhoto!: boolean | null;
}
