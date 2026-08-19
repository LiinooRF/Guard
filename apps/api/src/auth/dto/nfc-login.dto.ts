import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  /**
   * Codigo de empresa que el guardia deja fijado en su telefono ("Codigo de
   * empresa" en la pantalla; slug en la base). Sirve para el mismo fin que
   * `tenantId` pero es escribible por una persona: el UUID solo aparece si el
   * servidor ya devolvio la lista para elegir, y ahi el guardia ya tuvo que
   * elegir a mano, que es justo lo que se quiere evitar en la garita.
   *
   * Se normaliza a minusculas y sin espacios: en un teclado de telefono el
   * autocorrector manda mayuscula inicial, y rechazar por eso seria un enigma
   * para el guardia.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'El código de empresa solo admite letras, números y guiones.',
  })
  @MinLength(3)
  @MaxLength(48)
  tenantSlug?: string;
}
