import { IsISO8601, IsUUID } from 'class-validator';

/**
 * Asignacion manual de una ronda (#62 minimo). La generacion automatica por
 * recurrencia con zona horaria del recinto sigue abierta en el issue #62.
 */
export class CreatePatrolDto {
  @IsUUID()
  guardId!: string;

  @IsISO8601()
  scheduledStartAt!: string;

  @IsISO8601()
  scheduledEndAt!: string;
}
