export const PUSH_QUEUE_NAME = 'push-delivery';
export const PUSH_JOB_NAME = 'deliver';

/**
 * Menos intentos que el correo (5) y arranque mas corto.
 *
 * No es un numero de negocio: es la vida util del aviso. Un push de panico que
 * llega veinte minutos tarde ya no sirve para nada —a esa altura el supervisor
 * se entero por radio o por el correo, que es el canal garantizado— y ademas
 * confunde, porque suena como si el evento fuera de ahora. Tres intentos con
 * backoff exponencial desde 2 s cubren el corte tipico del proveedor y se
 * rinden a tiempo.
 */
export const PUSH_JOB_ATTEMPTS = 3;
export const PUSH_JOB_BACKOFF_MS = 2_000;
