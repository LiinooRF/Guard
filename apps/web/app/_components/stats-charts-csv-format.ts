/**
 * Formato del CSV de informes (#87). Va en su propio archivo, sin `'use
 * client'`, para poder probarlo con Jest sin cargar React ni el DOM.
 */

/** Caracteres con los que Excel y LibreOffice arrancan una FORMULA. */
const INICIOS_DE_FORMULA = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escapa un campo para CSV separado por punto y coma.
 *
 * Dos cosas distintas pasan aca:
 *
 * 1. **Comillas y separadores**: lo de siempre, se encierra y se duplican las
 *    comillas.
 * 2. **Inyeccion de formulas**: un recinto llamado `=1+1` o, peor,
 *    `=HYPERLINK(...)` se EJECUTA al abrir el archivo en Excel. Los nombres de
 *    recintos y de guardias los escribe el cliente, asi que son entrada no
 *    confiable: se les antepone un apostrofo, que Excel entiende como "esto es
 *    texto" y no muestra en la celda.
 *
 * Se usa punto y coma y no coma porque en es-CL el separador decimal es la coma
 * y Excel abre el archivo con todo en una sola columna.
 */
export function escaparCampoCsv(valor: string): string {
  const texto = valor ?? '';
  const neutralizado = INICIOS_DE_FORMULA.some((inicio) => texto.startsWith(inicio))
    ? `'${texto}`
    : texto;
  if (/[";\r\n]/.test(neutralizado)) return `"${neutralizado.replace(/"/g, '""')}"`;
  return neutralizado;
}

/** Nombre de archivo seguro: sin acentos, sin espacios y sin nada que rompa una ruta. */
export function nombreArchivoCsv(base: string, ahora: Date = new Date()): string {
  const limpio = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${limpio || 'informe'}-${ahora.toISOString().slice(0, 10)}.csv`;
}
