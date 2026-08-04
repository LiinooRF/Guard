/**
 * Normalizacion de lo que devuelve manager.query() con el driver de Postgres.
 *
 * SELECT e INSERT ... RETURNING devuelven un arreglo PLANO de filas.
 * UPDATE y DELETE devuelven [filas, rowCount] — una tupla, no filas.
 *
 * Confundir las dos formas no rompe nada visible en un test con mock, y por eso
 * es una trampa cara: `resultado[0]` de un UPDATE es el ARREGLO de filas, y un
 * arreglo vacio es truthy, asi que `Boolean(resultado[0])` responde "si, afecto
 * filas" incluso cuando no afecto ninguna.
 *
 * Todo el modulo pasa por aca en vez de asumir una forma.
 */

/** Las filas devueltas, venga la respuesta plana o como tupla. */
export function filasDe<T>(resultado: unknown): T[] {
  if (!Array.isArray(resultado)) return [];
  const primero: unknown = resultado[0];
  const segundo: unknown = resultado[1];
  if (Array.isArray(primero) && typeof segundo === 'number') return primero as T[];
  return resultado as T[];
}

/** Cuantas filas toco la sentencia. Para UPDATE/DELETE usa el rowCount real. */
export function filasAfectadas(resultado: unknown): number {
  if (!Array.isArray(resultado)) return 0;
  const primero: unknown = resultado[0];
  const segundo: unknown = resultado[1];
  if (Array.isArray(primero) && typeof segundo === 'number') return segundo;
  return resultado.length;
}

/** count(*) llega como string desde el driver: bigint no cabe en un number JS. */
export function comoEntero(valor: string | number | null | undefined): number {
  if (valor === null || valor === undefined) return 0;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}
