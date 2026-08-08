/**
 * Deja el UID de una etiqueta NFC en la MISMA forma que produce la app.
 *
 * El movil normaliza lo que lee del chip (`nfc-reader.ts`):
 *
 *     id.replace(/[^0-9a-f]/gi, '').toUpperCase()
 *
 * y el alta guardaba `input.uid.trim()` a secas. Un instalador que pegue
 * `04:AA:BB:CC` —el formato mas comun de los lectores de terceros— dejaba la
 * etiqueta guardada CON los dos puntos, y al escanear la app manda `04AABBCC`:
 * el `WHERE tag.uid = $1` no coincide nunca.
 *
 * Fallaba en el peor sitio posible. El alta responde 201, la etiqueta aparece
 * vinculada en el panel, y el problema solo se descubre con un guardia parado
 * frente al punto. El propio formulario dice "UID leido por el instalador", asi
 * que el producto ya daba por hecho este flujo.
 */
export function normalizarUidNfc(uid: string): string {
  return uid.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Un UID de QR NO se toca: es base32 con prefijo (`VXQ-ZE7OSH...`) y quitarle
 * los caracteres no hexadecimales lo destruiria. Por eso la normalizacion mira
 * la tecnologia y no solo el texto.
 */
export function normalizarUidDeEtiqueta(uid: string, tech: string): string {
  const limpio = uid.trim();
  return tech === 'nfc' ? normalizarUidNfc(limpio) : limpio;
}

/**
 * Un UID de NFC son 4, 7 o 10 bytes: 8, 14 o 20 caracteres hexadecimales. La
 * app descarta cualquier otra cosa (`>= 8`, `<= 64`, largo par), asi que
 * aceptarla aqui crearia una fila que ningun escaneo puede igualar jamas.
 */
export function uidNfcValido(uid: string): boolean {
  return uid.length >= 8 && uid.length <= 64 && uid.length % 2 === 0;
}
