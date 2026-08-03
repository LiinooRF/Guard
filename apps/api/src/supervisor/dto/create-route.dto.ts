import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RouteCheckpointDto {
  @IsUUID()
  checkpointId!: string;

  /** Si ninguno viene marcado, el ultimo de la secuencia cierra la ronda. */
  @IsOptional()
  @IsBoolean()
  isClosingPoint?: boolean;
}

export class CreateRouteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(1)
  estimatedDurationMin!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  toleranceMin?: number;

  /** Secuencia ordenada: la posicion es el indice en este arreglo. */
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => RouteCheckpointDto)
  checkpoints!: RouteCheckpointDto[];
}

export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  estimatedDurationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  toleranceMin?: number;

  /**
   * Si viene, reemplaza la secuencia completa y SUBE LA VERSION de la ruta.
   * Las rondas ya ejecutadas no cambian: llevan su propio snapshot de puntos.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => RouteCheckpointDto)
  checkpoints?: RouteCheckpointDto[];
}
