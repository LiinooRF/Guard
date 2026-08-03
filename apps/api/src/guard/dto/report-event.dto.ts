import {
  IsIn,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const CRITICALITIES = ['info', 'baja', 'media', 'alta', 'panico'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export class ReportEventDto {
  @IsIn(CRITICALITIES)
  criticality!: Criticality;

  /** Obligatorio salvo en panico: quien aprieta el boton no escribe parrafos. */
  @ValidateIf((o: ReportEventDto) => o.criticality !== 'panico' || o.text !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  text?: string;

  /** Idempotencia del reenvio offline: lo genera el dispositivo. */
  @IsUUID()
  clientEventId!: string;

  /** Ronda asociada; si no viene, se usa la ultima ronda del guardia. */
  @IsOptional()
  @IsUUID()
  patrolId?: string;

  /** Correccion: referencia a la entrada anterior. La original no se toca. */
  @IsOptional()
  @IsUUID()
  correctsEventId?: string;

  @IsOptional()
  @IsISO8601()
  reportedAt?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;
}
