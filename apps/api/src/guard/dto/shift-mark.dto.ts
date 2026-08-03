import { IsLatitude, IsLongitude, IsOptional } from 'class-validator';

/**
 * Marcaje operativo de jornada: responde "¿está el guardia en su puesto?".
 *
 * NO es el registro electrónico de asistencia que regula la Dirección del
 * Trabajo — ese tiene requisitos propios que esto no cubre. No venderlo como
 * reemplazo del control de asistencia sin asesoría laboral previa.
 */
export class ShiftMarkDto {
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}
