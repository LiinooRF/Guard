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

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
