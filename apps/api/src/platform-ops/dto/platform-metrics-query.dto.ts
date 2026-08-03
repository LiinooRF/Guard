import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PlatformMetricsQueryDto {
  /**
   * Dias sin actividad tras los cuales un tenant se considera en riesgo de fuga.
   * Es parametro y no constante porque el corte razonable depende del negocio
   * del cliente: una empresa con rondas diarias se nota muerta en 3 dias, una
   * con un solo recinto de fin de semana no. Ver ## reglas en INTEGRACION.md
   * para por que no vive en rules.ts.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  inactivityDays?: number;
}
