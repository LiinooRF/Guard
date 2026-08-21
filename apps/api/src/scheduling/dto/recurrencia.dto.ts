import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class CrearRecurrenciaDto {
  @IsUUID()
  guardId!: string;

  /**
   * Dias de la semana, 0 = domingo.
   *
   * Misma convencion que `shifts.weekdays` y que `EXTRACT(DOW)` de PostgreSQL.
   * Inventar otra numeracion seria garantizar un error de un dia en algun borde.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @Type(() => Number)
  weekdays!: number[];

  /** Desde cuando rige, YYYY-MM-DD. */
  @IsDateString()
  @Matches(FECHA, { message: 'startsOn debe ser una fecha YYYY-MM-DD' })
  startsOn!: string;

  /** Hasta cuando. Se omite para un turno fijo sin termino, que es lo normal. */
  @IsOptional()
  @IsDateString()
  @Matches(FECHA, { message: 'endsOn debe ser una fecha YYYY-MM-DD' })
  endsOn?: string;
}

export class ActivarRecurrenciaDto {
  @IsBoolean()
  isActive!: boolean;
}

export class RecurrenciaParam {
  @IsUUID()
  recurrenceId!: string;
}
