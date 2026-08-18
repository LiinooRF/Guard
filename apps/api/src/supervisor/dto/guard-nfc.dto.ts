import { IsOptional, IsString, Matches } from 'class-validator';

export class AssignGuardNfcCardDto {
  /**
   * PIN OPCIONAL, de 4 a 8 digitos. `null` o cadena vacia lo QUITAN; omitirlo
   * no lo toca, para que asignar una tarjeta no borre sin querer el PIN que ya
   * tenia el guardia.
   *
   * Solo digitos: el guardia lo teclea con una mano, con guantes y de noche.
   */
  @IsOptional()
  @Matches(/^([0-9]{4,8})?$/, {
    message: 'El PIN debe tener entre 4 y 8 digitos, o quedar vacio para no usar PIN.',
  })
  nfcPin?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{4,64}$/, {
    message: 'El UID de la tarjeta NFC debe tener entre 4 y 64 caracteres hexadecimales.',
  })
  nfcCardUid?: string | null;
}
