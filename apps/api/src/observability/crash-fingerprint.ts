import { createHash } from 'node:crypto';

/**
 * Huella para agrupar caidas iguales (#27).
 *
 * SIN AGRUPAR, EL REPORTE ES RUIDO. Una app que se cae al abrir la camara se
 * cae mil veces en un turno; si cada caida es una fila distinta, el panel del
 * ADMIN muestra mil problemas y en realidad hay uno. Agrupado, muestra
 * "1 problema, 1000 veces, todos en Redmi 9A" — que ademas es el titular que
 * sirve para decidir.
 *
 * Se calcula SOBRE EL TEXTO YA DEPURADO. Si se calculara sobre el original, la
 * huella seria una funcion de datos personales: no los revela, pero permite
 * confirmar una sospecha probando valores. Ademas dos caidas identicas con
 * distinto correo adentro caerian en grupos distintos, que es justo lo que no
 * se quiere.
 */

/**
 * Los numeros se reemplazan por `#`: los ids, las lineas y las horas cambian
 * entre dos ocurrencias del MISMO problema, y sin esto no agruparia nada.
 */
function normalizar(parte: string): string {
  return parte
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 16 hex = 64 bits. Para agrupar caidas de un producto de este tamaño sobra, y
 * cabe entero en el CHECK de la columna `fingerprint`.
 */
export function calcularHuella(partes: readonly string[]): string {
  const material = partes
    .filter((parte) => typeof parte === 'string' && parte.length > 0)
    .map(normalizar)
    .join('|');

  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/**
 * La huella de una caida: tipo de error + mensaje + los primeros cuadros de la
 * pila. Solo los primeros: mas abajo la pila es del framework y es identica
 * para problemas distintos.
 */
export function huellaDeCaida(
  errorName: string,
  errorMessage: string,
  stack: readonly string[],
  cuadros = 3,
): string {
  return calcularHuella([errorName, errorMessage, ...stack.slice(0, cuadros)]);
}
