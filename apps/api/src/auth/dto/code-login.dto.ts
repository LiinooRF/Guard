import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Ingreso del guardia con el codigo de empresa y su codigo personal.
 *
 * No lleva usuario: el codigo identifica y autentica a la vez. Esa es la
 * comodidad que se pidio y tambien lo que obliga a bloquear por empresa + IP,
 * porque aca no hay una identidad contra la cual contar intentos.
 */
export class CodeLoginDto {
  /** El que el telefono ya recuerda: al guardia se le llama "codigo de empresa". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  tenantSlug!: string;

  /*
   * Seis digitos exactos. Se valida la FORMA aca para que un intento con letras
   * o de largo distinto muera antes de tocar la base: es ruido que solo sirve
   * para gastar el bloqueo de los guardias legitimos.
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código son 6 dígitos.' })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceInfo?: string;
}
