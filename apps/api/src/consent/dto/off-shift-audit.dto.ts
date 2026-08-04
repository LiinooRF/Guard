import { IsOptional, IsUUID, Matches } from 'class-validator';

const FECHA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rango del informe "no se rastrea fuera del turno".
 *
 * Son FECHAS (AAAA-MM-DD), no instantes: el periodo se interpreta en la zona
 * horaria de CADA recinto (sites.timezone), no en la del servidor ni en la del
 * navegador que consulta. Un recinto en Santiago y otro en Isla de Pascua no
 * empiezan el dia a la misma hora, y en el cambio de horario el dia dura 23 o
 * 25 horas.
 *
 * Sin default a proposito: un rango implicito haria que dos personas mirando
 * "el informe" vieran periodos distintos sin saberlo. Quien consulta elige el
 * periodo que va a mostrar.
 */
export class OffShiftAuditQuery {
  @Matches(FECHA_LOCAL, { message: 'La fecha de inicio debe venir como AAAA-MM-DD' })
  from!: string;

  /** Inclusivo: el dia indicado entra completo. */
  @Matches(FECHA_LOCAL, { message: 'La fecha de término debe venir como AAAA-MM-DD' })
  to!: string;

  /** Opcional: acota el informe a un recinto. */
  @IsOptional()
  @IsUUID()
  siteId?: string;
}
