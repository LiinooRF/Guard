/**
 * Reglas del logo del tenant (#117), separadas del componente para poder
 * probarlas sin DOM.
 *
 * El contrato (`tenantBrandingSchema.logoUri`) admite hasta 2 MB de texto, pero
 * ese es el techo de la BASE, no el objetivo: el logo viaja en CADA respuesta
 * de `GET /branding` y se pinta en la esquina de todas las pantallas, tambien
 * en el telefono del guardia con datos moviles. 150 KB de archivo son ~200 KB
 * de data URI y ya es un logo generoso.
 */

/** Formatos que un `<img>` dibuja en todos los WebView del producto. */
export const FORMATOS_DE_LOGO = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;

export const MAX_LOGO_BYTES = 150 * 1024;

export type VeredictoLogo =
  | { valido: true }
  | { valido: false; motivo: string };

export function validarLogo(tipo: string, bytes: number): VeredictoLogo {
  if (!(FORMATOS_DE_LOGO as readonly string[]).includes(tipo)) {
    return {
      valido: false,
      motivo: 'El logo debe ser PNG, JPEG, WebP o SVG. Otros formatos no se dibujan en todos los teléfonos.',
    };
  }
  if (bytes > MAX_LOGO_BYTES) {
    return {
      valido: false,
      motivo: `El archivo pesa ${Math.round(bytes / 1024)} KB y el máximo es ${MAX_LOGO_BYTES / 1024} KB. El logo viaja a cada pantalla, incluido el teléfono del guardia con datos móviles: expórtalo más liviano.`,
    };
  }
  return { valido: true };
}

/**
 * `null` significa "sin cambio" en el PUT solo si el campo se omite; enviar
 * `logoUri: null` BORRA el logo. Esta funcion deja la intencion escrita.
 */
export function logoParaEnviar(opciones: {
  actual: string | null;
  nuevo: string | null;
  quitar: boolean;
}): string | null {
  if (opciones.quitar) return null;
  return opciones.nuevo ?? opciones.actual;
}
