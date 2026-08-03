import { IsDateString, IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * `YYYY-MM-DD` y nada mas. Un `2026-08-03T22:00:00Z` seria ambiguo justo donde
 * no se puede: la fecha de servicio es una fecha del CALENDARIO DEL RECINTO, y
 * el instante que la acompaña depende de la zona horaria de ese recinto — que
 * es lo que resuelve el SQL. Aceptar un instante aca invitaria a que el cliente
 * lo calcule con su propio huso.
 */
const FECHA_CALENDARIO = /^\d{4}-\d{2}-\d{2}$/;

export class PreviewScheduleQueryDto {
  @Matches(FECHA_CALENDARIO, { message: 'date debe ser una fecha YYYY-MM-DD' })
  @IsDateString()
  date!: string;
}

export class GenerateScheduleDto {
  @Matches(FECHA_CALENDARIO, { message: 'serviceDate debe ser una fecha YYYY-MM-DD' })
  @IsDateString()
  serviceDate!: string;

  /** Sin recinto: todos los recintos que el supervisor tiene asignados. */
  @IsOptional()
  @IsUUID()
  siteId?: string;
}
