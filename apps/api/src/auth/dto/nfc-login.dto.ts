import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class NfcLoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9A-F]{4,64}$/, {
    message: 'El UID de la tarjeta NFC debe contener entre 4 y 64 caracteres hexadecimales.',
  })
  cardUid!: string;

  /**
   * PIN OPCIONAL. Solo hace falta si el supervisor se lo configuro a ese
   * guardia; si no tiene, el login sigue siendo solo la tarjeta.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 digitos.' })
  pin?: string;

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
