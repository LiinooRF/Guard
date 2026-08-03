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
  /** Mismo largo minimo que el CHECK de tenant_deletions.reason. */
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
