import { Transform } from 'class-transformer';
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

  /**
   * Obligatorio salvo en panico: quien aprieta el boton no escribe parrafos.
   *
   * Se recorta ANTES de validar porque el CHECK de la columna mide recortado
   * —`criticality = 'panico' OR (text IS NOT NULL AND length(trim(text)) >= 3)`,
   * 1723820400000-CreateFieldEvents.ts:31— y GuardService lo inserta tal cual
   * (guard.service.ts:600). Una novedad de `"  a  "` medía 5 para el validador
   * y 1 para PostgreSQL: 500 en vez de 400, y encima en el camino del boton de
   * panico.
   *
   * Un texto que despues de recortar queda vacio se trata como "no vino texto"
   * y no como "vino un texto invalido". Es a proposito: asi el panico —que no
   * exige texto— NO se rechaza porque la app haya mandado el campo en blanco, y
   * la novedad normal sigue pidiendo sus 3 caracteres por el `@ValidateIf`. El
   * boton de panico no puede fallar por un espacio.
   */
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const recortado = value.trim();
    return recortado.length > 0 ? recortado : undefined;
  })
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
