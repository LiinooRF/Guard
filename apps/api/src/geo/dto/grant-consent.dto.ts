import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GrantConsentDto {
  /**
   * Version del texto informativo que el trabajador acepto. Es lo que convierte
   * la fila en prueba: sin saber QUE se le mostro, la aceptacion no acredita el
   * aviso previo. Si el texto cambia, hay que volver a pedir consentimiento.
   */
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
