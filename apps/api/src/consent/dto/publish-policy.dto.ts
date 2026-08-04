import { IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Publicacion del aviso de geolocalizacion (#78).
 *
 * Los tres campos son obligatorios a proposito: un aviso sin texto no informa y
 * un aviso sin politica de privacidad publicada no pasa la revision de Google
 * Play. No hay "borrador": lo que se publica ya es lo que ve el trabajador.
 */
export class PublishPolicyDto {
  /**
   * Nombre de la version, tal como quedara guardado en cada aceptacion
   * (gps_consents.policy_version). Sin espacios ni acentos para que sirva de
   * llave estable entre la app, el informe y la base.
   */
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
  @IsString()
  @MaxLength(500)
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_tld: true },
    { message: 'La política de privacidad debe ser una dirección https pública' },
  )
  privacyPolicyUrl!: string;
}
