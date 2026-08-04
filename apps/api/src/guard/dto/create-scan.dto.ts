import {
  IsIn,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateScanDto {
  /** UID leido de la etiqueta. El servidor resuelve a que punto pertenece. */
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;

  @IsIn(['nfc', 'qr'])
  method!: 'nfc' | 'qr';

  /**
   * Lo genera EL DISPOSITIVO al escanear. Es la clave de idempotencia del
   * reenvio offline: mandar el mismo escaneo tres veces deja una sola fila.
   */
  @IsUUID()
  clientScanId!: string;

  /** Hora del telefono al escanear. La del servidor se registra aparte. */
  @IsOptional()
  @IsISO8601()
  scannedAt?: string;

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

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  signature?: string;
}
