import { IsISO8601, IsOptional } from 'class-validator';

export class SiteSummaryQueryDto {
  /** Inicio del periodo (ISO 8601). Sin valor: 30 dias antes de `to`. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Fin del periodo (ISO 8601), exclusivo. Sin valor: ahora. */
  @IsOptional()
  @IsISO8601()
  to?: string;
}
