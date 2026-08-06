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

import { MAX_PUNTOS_POR_LOTE } from '../gps-rules';

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
   * señal: el tope de MAX_PUNTOS_POR_LOTE puntos es una ronda larga completa a
   * intervalo de un minuto, con margen.
   *
   * El tope sale de la constante y no de un literal: es el mismo numero que
   * limita `gpsTrackBatchSize` y que recorta el plan que se le entrega al
   * telefono. Con literales sueltos se podia subir el del endpoint y dejar al
   * telefono pidiendo lotes mas chicos sin que nada fallara.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUNTOS_POR_LOTE)
  @ValidateNested({ each: true })
  @Type(() => TrackPointDto)
  points!: TrackPointDto[];
}
