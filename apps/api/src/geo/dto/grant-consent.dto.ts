import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GrantConsentDto {
  /**
   * Version del texto informativo que el trabajador acepto. Es lo que convierte
   * la fila en prueba: sin saber QUE se le mostro, la aceptacion no acredita el
   * aviso previo. Si el texto cambia, hay que volver a pedir consentimiento.
   *
   * Se recorta ANTES de validar: GeoService la inserta tal cual
   * (geo.service.ts:286) y el CHECK mide
   * `length(trim(policy_version)) BETWEEN 1 AND 40`
   * (1724511600000-CreateTrackAndConsent.ts:82). Una version de puros espacios
   * pasaba el `@MinLength(1)` y reventaba contra la restriccion con un 500.
   * Ademas el recorte hace que la version aceptada coincida con la publicada,
   * que ConsentService guarda ya recortada.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  policyVersion!: string;

  /** Marca y modelo del equipo. Nada que identifique a la persona ni al chip. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceInfo?: string;
}
