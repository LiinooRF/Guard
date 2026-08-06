import { Transform } from 'class-transformer';
import { IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Publicacion del aviso de geolocalizacion (#78).
 *
 * Los tres campos son obligatorios a proposito: un aviso sin texto no informa y
 * un aviso sin politica de privacidad publicada no pasa la revision de Google
 * Play. No hay "borrador": lo que se publica ya es lo que ve el trabajador.
 *
 * Los tres se RECORTAN antes de validar, y eso no es cosmetico. ConsentService
 * guarda `input.body.trim()` (consent.service.ts:232) y el CHECK de la tabla
 * mide `length(trim(body)) BETWEEN 100 AND 20000`
 * (1725472800000-CreateConsentPolicies.ts:46). Validando sin recortar, un aviso
 * de exactamente 100 caracteres con espacios en las puntas pasaba el
 * `@MinLength(100)` y llegaba a PostgreSQL con menos de 100: violacion del
 * CHECK, o sea un 500 donde correspondia un 400.
 *
 * Es el hermano del 500 del regex `{4,500}` (#242) y tiene la misma causa: que
 * la validacion y la restriccion midan cosas distintas. El DTO tiene que
 * validar EXACTAMENTE lo que se guarda; si no, el validador termina siendo la
 * base, y la forma que tiene la base de rechazar es un error 500.
 */
export class PublishPolicyDto {
  /**
   * Nombre de la version, tal como quedara guardado en cada aceptacion
   * (gps_consents.policy_version). Sin espacios ni acentos para que sirva de
   * llave estable entre la app, el informe y la base.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'La versión solo admite letras, números, punto, guion y guion bajo (ej: 2026-v1)',
  })
  version!: string;

  /**
   * El aviso completo. Tiene que decir QUE se registra, CUANDO, PARA QUE y por
   * CUANTO tiempo se conserva; el minimo de 100 caracteres es el piso para que
   * no se publique una frase suelta.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(100, {
    message:
      'El aviso es demasiado corto: tiene que explicar qué se registra, cuándo, para qué y por cuánto tiempo se guarda',
  })
  @MaxLength(20000)
  body!: string;

  /**
   * URL publica de la politica de privacidad. https obligatorio: es la que se
   * enlaza desde la ficha de Play Store y desde la app, y tiene que abrir sin
   * sesion.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_tld: true },
    { message: 'La política de privacidad debe ser una dirección https pública' },
  )
  privacyPolicyUrl!: string;
}
