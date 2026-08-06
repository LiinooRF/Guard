import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Parametros de las consultas de traza (#134).
 *
 * Van en su propio archivo y no en `dto/gps-query.dto.ts` para no tocar el
 * carril de #77: los tipos son identicos pero el dueño de aquel archivo no tiene
 * por que enterarse de este issue.
 */
export class TrazaPatrolParam {
  @IsUUID()
  patrolId!: string;
}

export class TrazaSiteParam {
  @IsUUID()
  siteId!: string;
}

/**
 * Ventana por defecto de la serie diaria. Una semana de operacion.
 *
 * No es una regla de negocio y por eso no va a rules.ts: es el valor que asume
 * la consulta cuando el panel no pide otro, y el panel puede pedir cualquiera
 * dentro del rango.
 */
export const DIAS_TRAZA_POR_DEFECTO = 7;

export class TrazaDiariaQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number;
}
