import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Length(3, 254)
  identity!: string;

  @IsString()
  @Length(8, 128)
  password!: string;

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
