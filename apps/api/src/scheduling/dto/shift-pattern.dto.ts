import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ShiftPatternDto {
  @IsUUID()
  routeId!: string;

  /** Cuantas rondas de esta ruta se generan dentro del turno. */
  @IsInt()
  @Min(1)
  @Max(48)
  patrolsPerShift!: number;

  /**
   * Separacion minima entre rondas del mismo turno. Si el turno no da para las
   * rondas pedidas con esta separacion, se generan las que caben: el guardia no
   * puede recorrer mas rapido porque la configuracion lo pida.
   *
   * Obligatorio a proposito: un default en el codigo seria una regla de negocio
   * fija, y cuanto descanso necesita una ronda depende del recinto.
   */
  @IsInt()
  @Min(0)
  @Max(1440)
  minGapMinutes!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Reemplaza el set COMPLETO de patrones del turno: lo omitido se elimina. */
export class ReplaceShiftPatternsDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ShiftPatternDto)
  patterns!: ShiftPatternDto[];
}
