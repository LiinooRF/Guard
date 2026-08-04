import type { PushNotification } from './push-provider';

/**
 * Lo que viaja a Redis.
 *
 * NO LLEVA TOKENS, y esa es la decision de diseño de este archivo. La cola
 * retiene los jobs completados para conservar la idempotencia
 * (`removeOnComplete: false`, igual que el correo), asi que todo lo que se
 * escriba aca queda en Redis indefinidamente. Un token de push es la credencial
 * que permite mandarle notificaciones a un telefono concreto: no se archiva.
 *
 * El worker resuelve los tokens al enviar, dentro de su propia transaccion con
 * contexto de tenant. Ademas de no archivarlos, resuelve el caso real de que el
 * dispositivo se registre o se dé de baja entre el encolado y el envio.
 */
export interface PushJobData {
  /** El worker no tiene request: el tenant viaja para poder abrir su RLS. */
  readonly tenantId: string;
  /** Un job por destinatario. Ver PushService.send. */
  readonly userId: string;
  readonly notification: PushNotification;
}

export interface EnqueuePushOptions {
  /**
   * Identifica el HECHO de negocio, no el intento de entrega. Se le agrega el
   * destinatario: dos supervisores del mismo panico son dos avisos, pero el
   * mismo panico reenviado al mismo supervisor es uno solo.
   */
  readonly idempotencyKey: string;
}
