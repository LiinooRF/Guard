import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

export class SiteBusinessHourDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  opensAt!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  closesAt!: string;
}

export class ReplaceSiteBusinessHoursDto {
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => SiteBusinessHourDto)
  hours!: SiteBusinessHourDto[];
}

export class SiteHolidayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  /**
   * Se recorta ANTES de validar: AdminService guarda `holiday.name?.trim()` y
   * el CHECK es `name IS NULL OR length(trim(name)) BETWEEN 2 AND 120`. Sin el
   * recorte, un ` x` medía 2 para el validador y 1 para PostgreSQL, y el feriado
   * se caia con 500 en vez de 400.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;
}

export class ReplaceSiteHolidaysDto {
  @IsArray()
  @ArrayMaxSize(366)
  @ValidateNested({ each: true })
  @Type(() => SiteHolidayDto)
  holidays!: SiteHolidayDto[];
}
