import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class GeoPatrolParam {
  @IsUUID()
  patrolId!: string;
}

export class GeoSiteParam {
  @IsUUID()
  siteId!: string;
}

/**
 * El recinto es opcional: sin el, la politica se resuelve al nivel de la
 * empresa. Con el, la cascada aplica ademas el override del recinto — que es lo
 * que necesita el guardia, porque el estacionamiento subterraneo y la porteria
 * de la entrada no se configuran igual.
 */
export class GpsPolicyQuery {
  @IsOptional()
  @IsUUID()
  siteId?: string;
}

/** Ventana por defecto del informe de cobertura. Dos semanas de operacion. */
export const DIAS_COBERTURA_POR_DEFECTO = 14;

export class GpsCoverageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
