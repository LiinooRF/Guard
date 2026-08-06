import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ScheduleDeletionDto {
  /**
   * Mismo largo minimo que el CHECK de tenant_deletions.reason — pero el CHECK
   * mide `length(trim(reason)) >= 10` y aca no se recortaba, asi que "mismo
   * largo minimo" era falso: un motivo de 10 caracteres con espacios en las
   * puntas pasaba el `@MinLength(10)` y reventaba contra la restriccion con un
   * 500. Es el mismo defecto que el aviso de GPS (#242).
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  /** Dias de retencion antes del purge; si no viene, 30. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  retentionDays?: number;
}
