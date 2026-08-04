import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Alta de un dispositivo para push (#113).
 *
 * El token lo emite el proveedor y su formato no es un contrato estable, asi
 * que no se valida contra una forma inventada: se acota el largo y se prohiben
 * los espacios y los caracteres de control. Eso es lo que evita que el campo se
 * use como bolsa de texto libre —termina en la base y en la URL del DELETE— sin
 * rechazar tokens legitimos cuando el proveedor cambie su formato.
 */
export class RegisterDeviceDto {
  @IsString()
  @Length(8, 4096)
  @Matches(/^[\x21-\x7e]+$/, {
    message: 'El token solo puede tener caracteres ASCII imprimibles sin espacios',
  })
  token!: string;

  // Solo Android: iOS esta fuera de alcance. El CHECK de la tabla dice lo
  // mismo, y aca ademas devuelve 400 en vez de un error de base.
  @IsIn(['android'])
  platform!: 'android';

  /** Version del shell. Explica por que un telefono no abre un deep link nuevo. */
  @IsOptional()
  @IsString()
  @Length(1, 32)
  appVersion?: string;
}
