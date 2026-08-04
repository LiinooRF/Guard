import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsInt,
  IsMilitaryTime,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const FECHA_CALENDARIO = /^\d{4}-\d{2}-\d{2}$/;

export class CreateShiftDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  /** HH:MM. Si `startsAt` > `endsAt` es un turno nocturno que cruza medianoche. */
  @IsMilitaryTime()
  startsAt!: string;

  @IsMilitaryTime()
  endsAt!: string;

  /** 0 = domingo … 6 = sábado. Por defecto, todos los días. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays?: number[];

  @IsOptional()
  @IsInt()
  @Min(0)
  entryToleranceMin?: number;
}

export class AssignShiftDto {
  @IsUUID()
  guardId!: string;

  /** Fecha de servicio en formato YYYY-MM-DD. */
  @IsDateString()
  @Matches(FECHA_CALENDARIO, { message: 'serviceDate debe ser una fecha YYYY-MM-DD' })
  serviceDate!: string;
}

export class ReassignShiftDto {
  @IsUUID()
  guardId!: string;
}

export class WeekScheduleQueryDto {
  @IsDateString()
  @Matches(FECHA_CALENDARIO, { message: 'from debe ser una fecha YYYY-MM-DD' })
  from!: string;
}
