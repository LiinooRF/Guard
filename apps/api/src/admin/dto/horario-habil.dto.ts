import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * Instante a comprobar, expresado en hora LOCAL DEL RECINTO (#68).
 *
 * A proposito NO se recibe un instante ISO con zona: si el navegador tuviera
 * que convertir "sabado 03:00 en el recinto" a UTC, tendria que conocer el huso
 * y sus cambios de horario de verano. La conversion la hace Postgres con
 * sites.timezone, que es la unica fuente de verdad del huso.
 *
 * Ambos campos van juntos o no va ninguno; sin ellos se comprueba el ahora.
 */
export class ComprobarHorarioQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe venir como YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'La hora debe venir como HH:MM' })
  time?: string;
}

export class RecintoParam {
  @IsUUID()
  siteId!: string;
}
