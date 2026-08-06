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
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateScanDto {
  /**
   * UID leido de la etiqueta. El servidor resuelve a que punto pertenece.
   *
   * Se recorta ANTES de validar: todo el que lo usa lo recorta despues
   * —`input.uid.trim()` en guard.service.ts:268, en device-signature.service.ts:17
   * y en sync.service.ts:403— y el ultimo termina en `late_scans.tag_uid`, cuyo
   * CHECK mide sin recortar (`length(tag_uid) BETWEEN 4 AND 64`,
   * 1725462020000-CreateClockSkewAndLateScans.ts:105). Un `"  ab"` medía 4 aqui y
   * 2 alla: 500 al registrar el escaneo atrasado.
   *
   * Recortar aca ademas deja UNA sola forma del UID: la que se firma, la que se
   * busca y la que se guarda son la misma cadena.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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
