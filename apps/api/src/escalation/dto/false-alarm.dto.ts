import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class FalseAlarmDto {
  /**
   * Se recorta antes de validar: field_events exige length(trim(text)) >= 3 y
   * un motivo de puros espacios reventaria contra ese CHECK, no contra el DTO.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}
