import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlaces firmados para servir evidencia fotografica (#69).
 *
 * El archivo NO se sirve por ruta adivinable ni desde un directorio estatico:
 * la unica forma de leer los bytes es un enlace firmado que caduca.
 *
 * El enlace es un token al portador: quien lo tenga, ve la foto mientras dure.
 * Eso es lo que lo hace servible desde un <img> y desde el generador de PDF sin
 * arrastrar la sesion, y es tambien la razon de que la vigencia sea corta. El
 * control de acceso real esta en el endpoint que EMITE el enlace, que si exige
 * sesion, permiso y tenant.
 */

/**
 * Cinco minutos: alcanza de sobra para pintar una galeria o armar un PDF, y no
 * para que el enlace sobreviva en el historial del navegador o en un correo
 * reenviado. No es un parametro de negocio configurable por el admin: bajarlo
 * o subirlo cambia la seguridad del producto, no como opera una empresa.
 */
export const VIGENCIA_ENLACE_MS = 5 * 60 * 1000;

/**
 * Clave DERIVADA de JWT_SECRET, no JWT_SECRET a secas.
 *
 * Reusar la misma clave para firmar sesiones y enlaces significa que una
 * confusion entre ambos formatos se convierte en una falsificacion. Derivar por
 * proposito cuesta una linea y separa los dominios sin agregar otra variable de
 * entorno que alguien tenga que recordar rotar.
 */
function claveDeEnlaces(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('sentrycore:evidence-links:v1').digest();
}

/**
 * La firma cubre el tenant ademas de la foto y el vencimiento: sin eso, un
 * enlace valido seguiria siendolo si la fila cambiara de dueño, y el aislamiento
 * entre empresas dejaria de depender solo de RLS.
 */
function firmar(jwtSecret: string, photoId: string, tenantId: string, expira: number): string {
  return createHmac('sha256', claveDeEnlaces(jwtSecret))
    .update(`${photoId}.${tenantId}.${expira}`)
    .digest('hex');
}

export interface EnlaceFirmado {
  readonly path: string;
  readonly expiresAt: Date;
}

export function firmarEnlace(
  jwtSecret: string,
  photoId: string,
  tenantId: string,
  ahora: Date = new Date(),
): EnlaceFirmado {
  const expira = ahora.getTime() + VIGENCIA_ENLACE_MS;
  const sig = firmar(jwtSecret, photoId, tenantId, expira);
  return {
    path: `/evidence/photos/${photoId}?exp=${expira}&tenant=${tenantId}&sig=${sig}`,
    expiresAt: new Date(expira),
  };
}

export type VeredictoEnlace =
  | { readonly valido: true; readonly tenantId: string }
  | { readonly valido: false; readonly motivo: 'vencido' | 'firma' };

export function verificarEnlace(
  jwtSecret: string,
  photoId: string,
  tenantId: string,
  exp: string,
  sig: string,
  ahora: Date = new Date(),
): VeredictoEnlace {
  const expira = Number(exp);
  if (!Number.isFinite(expira)) return { valido: false, motivo: 'firma' };

  const esperada = Buffer.from(firmar(jwtSecret, photoId, tenantId, expira), 'utf8');
  const recibida = Buffer.from(sig, 'utf8');
  // Comparacion en tiempo constante y con largo comprobado antes:
  // timingSafeEqual lanza si difieren, y un throw seria el mismo canal lateral
  // que se quiere evitar.
  if (esperada.length !== recibida.length) return { valido: false, motivo: 'firma' };
  if (!timingSafeEqual(esperada, recibida)) return { valido: false, motivo: 'firma' };

  // El vencimiento se comprueba DESPUES de la firma: al reves, un atacante
  // aprende si un exp inventado ya paso, que es informacion que no le toca.
  if (expira <= ahora.getTime()) return { valido: false, motivo: 'vencido' };

  return { valido: true, tenantId };
}
