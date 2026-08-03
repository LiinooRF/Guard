import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class TrackPointDto {
  /** Hora del telefono al muestrear. Es la clave del punto dentro de la ronda. */
  @IsISO8601()
  recordedAt!: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;

  /**
   * Bateria al momento del punto. Sirve para explicar un hueco en la traza sin
   * acusar a nadie: un telefono en 3% deja de muestrear.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPct?: number;
}

export class AppendTrackDto {
  /**
   * Lote del muestreo en segundo plano. Llega junto porque en terreno no hay
   * señal: el tope de 500 puntos es una ronda larga completa a intervalo de un
   * minuto, con margen.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TrackPointDto)
  points!: TrackPointDto[];
}
