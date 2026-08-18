import { Transform } from 'class-transformer';
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
} from 'class-validator';

export class CreateCheckpointDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /** `acceso_critico` hereda foto obligatoria de las reglas del tenant. */
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

  /**
   * Sobreescribe la regla de foto SOLO para este punto. Si no viene, manda la
   * regla del tenant (`isPhotoRequired()` en @sentrycore/shared).
   */
  @IsOptional()
  @IsBoolean()
  requiresPhoto?: boolean;

  /** Que tiene que revisar el guardia en este punto. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  /**
   * UID leido durante la instalacion; se vincula en la misma transaccion.
   *
   * Se recorta antes de validar por lo mismo que `RegisterTagDto.uid`: el CHECK
   * de `tags` mide sin recortar y AdminService inserta `input.tagUid.trim()`
   * (admin.service.ts:609).
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  tagUid?: string;
}
