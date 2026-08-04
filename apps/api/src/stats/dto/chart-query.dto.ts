import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const MENSAJE_FECHA = 'debe ser un dia calendario con formato YYYY-MM-DD';

/** Granularidad de la serie temporal. El cubo diario es la unidad minima. */
export const GRANULARIDADES = ['dia', 'semana', 'mes'] as const;
export type Granularidad = (typeof GRANULARIDADES)[number];

/**
 * Filtros comunes de las graficas.
 *
 * `from`/`to` son DIAS del recinto, no instantes: la conversion a zona horaria
 * ocurre en el SQL con `sites.timezone`. Si el navegador mandara un instante,
 * el corte del dia terminaria dependiendo de donde este sentado quien mira el
 * panel.
 */
export class ChartQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `\`from\` ${MENSAJE_FECHA}` })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `\`to\` ${MENSAJE_FECHA}` })
  to?: string;

  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branchName?: string;
}

export class EvolutionQueryDto extends ChartQueryDto {
  @IsOptional()
  @IsIn(GRANULARIDADES, { message: 'granularity debe ser dia, semana o mes' })
  granularity?: Granularidad;
}

export class TopQueryDto extends ChartQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
