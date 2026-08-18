import { IsOptional, IsString, Matches } from 'class-validator';

export class AssignGuardNfcCardDto {
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{4,64}$/, {
    message: 'El UID de la tarjeta NFC debe tener entre 4 y 64 caracteres hexadecimales.',
  })
  nfcCardUid?: string | null;
}
