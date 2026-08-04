import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const ROUTE_ORDER_MODES = ['fijo', 'aleatorio', 'aleatorio_con_anclas'] as const;
export type RouteOrderMode = (typeof ROUTE_ORDER_MODES)[number];

export class RouteCheckpointDto {
  @IsUUID()
  checkpointId!: string;

  /** Si ninguno viene marcado, el ultimo de la secuencia cierra la ronda. */
  @IsOptional()
  @IsBoolean()
  isClosingPoint?: boolean;

  /** En modo 'aleatorio_con_anclas', este punto conserva su posicion en el sorteo. */
  @IsOptional()
  @IsBoolean()
  isAnchor?: boolean;

  /** Override del punto, editable solo dentro de un recinto asignado. */
  @IsOptional()
  @IsBoolean()
  requiresPhoto?: boolean;
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

  /**
   * Anti-predictibilidad (#65). El sorteo ocurre al generar cada ronda, nunca
   * al vuelo: el snapshot de la ronda es el orden auditable. Default: 'fijo'.
   */
  @IsOptional()
  @IsIn(ROUTE_ORDER_MODES)
  orderMode?: RouteOrderMode;

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

  @IsOptional()
  @IsIn(ROUTE_ORDER_MODES)
  orderMode?: RouteOrderMode;

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
