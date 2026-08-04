import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CONFIG_AREAS, CONFIG_SCOPES } from '../config-audit.catalog';

/** AAAA-MM-DD. El dia calendario, que es como piensa el jefe de operaciones. */
const DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filtros del historial de configuracion (#84).
 *
 * Hay dos formas de acotar el tiempo y no sobran:
 *   - `from` / `to`: instantes ISO-8601, para rangos exactos.
 *   - `fromDay` / `toDay`: dias calendario en la zona horaria del recinto, que
 *     es lo que necesita "el mes pasado". El servidor devuelve la zona que
 *     efectivamente uso.
 */
export class ConfigAuditQuery {
  @IsOptional()
  @IsIn([...CONFIG_AREAS])
  area?: (typeof CONFIG_AREAS)[number];

  @IsOptional()
  @IsIn([...CONFIG_SCOPES])
  scope?: (typeof CONFIG_SCOPES)[number];

  /** Recinto o punto de control configurado. */
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  paramKey?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Matches(DIA, { message: 'fromDay debe ser una fecha AAAA-MM-DD' })
  fromDay?: string;

  @IsOptional()
  @Matches(DIA, { message: 'toDay debe ser una fecha AAAA-MM-DD' })
  toDay?: string;

  /** Zona IANA, por ejemplo America/Santiago. Si no se manda, la del recinto. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone?: string;

  /** Valor nuevo exacto: 40, true, "alta". */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  newValue?: string;

  /** 'bajo' = el numero quedo mas chico que antes; 'subio' = mas grande. */
  @IsOptional()
  @IsIn(['bajo', 'subio'])
  direction?: 'bajo' | 'subio';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Lo mismo para el resumen por parametro, que solo se acota por area. */
export class ConfigAuditParametersQuery {
  @IsOptional()
  @IsIn([...CONFIG_AREAS])
  area?: (typeof CONFIG_AREAS)[number];
}

/**
 * Filtros del lado plataforma. Sin dias ni zona horaria: el SUPERADMIN mira
 * empresas de husos distintos y un "dia" comun a todas no existe.
 */
export class PlatformConfigAuditQuery {
  @IsOptional()
  @IsIn([...CONFIG_AREAS])
  area?: (typeof CONFIG_AREAS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  paramKey?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
