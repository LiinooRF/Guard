import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Los seis digitos que escribe el guardia. */
export const LARGO_CODIGO = 6;

/**
 * Clave del SERVIDOR para construir el lookup determinista.
 *
 * Vive fuera de la base a proposito: si estuviera dentro, quien consiga un
 * volcado podria calcular el lookup de 000000..999999 y quedarse con el codigo
 * de cada guardia. Sin ella, esa lista no se puede construir.
 *
 * Se cae al arrancar si falta, en vez de improvisar un valor por omision: un
 * pepper por defecto seria el mismo en todas las instalaciones, que es no tener
 * pepper con la apariencia de tenerlo.
 */
export function pepperDeCodigo(env: NodeJS.ProcessEnv = process.env): string {
  const valor = env.LOGIN_CODE_PEPPER?.trim();
  if (!valor) {
    throw new Error(
      'Falta LOGIN_CODE_PEPPER: sin esa clave el ingreso por código no puede resolverse.',
    );
  }
  if (valor.length < 32) {
    throw new Error('LOGIN_CODE_PEPPER debe tener al menos 32 caracteres.');
  }
  return valor;
}

/**
 * Valor indexable con el que se encuentra al guardia.
 *
 * Lleva el tenant adentro para que el mismo codigo en dos empresas distintas de
 * lookups distintos: si no, el indice unico por empresa dejaria pasar
 * colisiones entre empresas y una busqueda podria devolver a alguien de otra.
 */
export function lookupDeCodigo(tenantId: string, codigo: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${tenantId}:${codigo}`).digest('hex');
}

/**
 * Codigo nuevo, aleatorio y sin patron.
 *
 * `randomInt` y no `Math.random()`: este numero es una credencial. Se permiten
 * todos los valores de 000000 a 999999 —incluido el que empieza en cero— y por
 * eso se rellena con ceros a la izquierda en vez de sortear entre 100000 y
 * 999999, que descartaria el 10 % del espacio sin ganar nada.
 */
export function generarCodigo(): string {
  return String(randomInt(0, 1_000_000)).padStart(LARGO_CODIGO, '0');
}

/** Comparacion en tiempo constante de dos lookups. */
export function lookupsIguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
