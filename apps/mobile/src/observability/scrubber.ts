/**
 * Limpieza de datos en la app antes de enviar reportes de caídas (#273).
 *
 * Primera línea de defensa: no confiar ciegamente en el scrubber del servidor.
 * La app NUNCA debe enviar correos, nombres, tokens, contraseñas, URLs con
 * parámetros de sesión ni cabeceras sensibles.
 */

const PATRON_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PATRON_BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const PATRON_JWT = /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g;
// Las cookies REALES de este producto (session-cookies.ts) son
// sentrycore_access y sentrycore_refresh, no connect.sid (esa es la de
// Express y este backend no la usa). La de acceso es un JWT y ya cae en
// PATRON_JWT de pura casualidad; el refresh es randomBytes(48).base64url y
// ningun otro patron lo toca — por eso va explicito y no solo por si acaso.
const PATRON_COOKIE = /(connect\.sid|sentrycore_access|sentrycore_refresh)=[A-Za-z0-9._~+/=%-]+/gi;
const PATRON_HEX_KEY = /([0-9a-f]{32,64})/gi;

export function sanitizarTexto(texto: string | null | undefined): string {
  if (!texto || typeof texto !== 'string') return '';

  return texto
    .replace(PATRON_BEARER, 'Bearer [REDACTED]')
    .replace(PATRON_JWT, '[JWT_REDACTED]')
    .replace(PATRON_COOKIE, '$1=[REDACTED]')
    .replace(PATRON_EMAIL, '[EMAIL_REDACTED]')
    .replace(PATRON_HEX_KEY, (match) => (match.length >= 32 ? '[KEY_REDACTED]' : match))
    .trim();
}

export function recortar(texto: string, maxLen: number): string {
  if (texto.length <= maxLen) return texto;
  return texto.slice(0, maxLen);
}
