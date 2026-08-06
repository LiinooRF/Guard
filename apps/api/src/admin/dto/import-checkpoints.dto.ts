import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ImportCheckpointRowDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

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
  @IsBoolean()
  requiresPhoto?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  /**
   * Se recorta ANTES de validar. El patron acepta el espacio (`\x20` es el
   * primer caracter del rango), asi que `"  ab"` cumplia el `{4,64}` del regex y
   * llegaba a `tags` como `"ab"` —AdminService inserta `checkpoint.tagUid.trim()`
   * (admin.service.ts:658)— contra un CHECK que mide sin recortar
   * (`length(uid) BETWEEN 4 AND 64`). Toda la importacion se caia con 500 por una
   * celda con espacios de sobra, que es exactamente lo que trae una planilla.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @Matches(/^[\x20-\x7E]{4,64}$/)
  tagUid?: string;
}

export class ImportCheckpointsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportCheckpointRowDto)
  checkpoints!: ImportCheckpointRowDto[];
}
