import type { DeepLink } from './deep-link';

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * Puerto de notificaciones push, igual que `MailProvider` con el correo.
 *
 * EL PROVEEDOR NO ESTA DECIDIDO Y ESO ES DELIBERADO. FCM es lo obvio para
 * Android, pero el codigo no se acopla a el: aca no aparece ninguna palabra de
 * FCM, ni su formato de mensaje, ni sus codigos de error. El adaptador traduce.
 * El dia que se decida —o que se cambie— se escribe otro adaptador y nada mas.
 */

/**
 * Urgencia del transporte, NO criticidad del negocio.
 *
 * Existen dos y no cinco porque es lo unico que un transporte distingue de
 * verdad: `alta` atraviesa el ahorro de bateria de Android (Doze) y suena; el
 * resto puede esperar a que el sistema junte trabajo. Mapear la criticidad del
 * evento a esto es decision del que envia, no del transporte.
 */
export type PushUrgency = 'alta' | 'normal';

export interface PushNotification {
  /** Corto: Android lo trunca en la barra de estado. */
  readonly title: string;
  /**
   * SIN datos personales ni detalle del evento. Se muestra en una pantalla
   * bloqueada que puede estar sobre una mesa, y viaja por un tercero. Recinto y
   * criticidad alcanzan para decidir si hay que correr; el resto esta detras de
   * la sesion.
   */
  readonly body: string;
  readonly deepLink: DeepLink;
  readonly urgency: PushUrgency;
  /**
   * Avisos del mismo hecho se reemplazan en la bandeja en vez de apilarse. Sin
   * esto, tres niveles de escalamiento del mismo panico dejan tres
   * notificaciones que hay que descartar una por una.
   */
  readonly collapseKey?: string;
}

/**
 * Veredicto POR TOKEN. El transporte responde por cada destino, no por el lote:
 * en un envio a tres dispositivos es normal que uno este muerto y los otros dos
 * entreguen.
 *
 *   entregado      — el transporte lo acepto.
 *   token-invalido — ese token ya no existe o no es de esta app. SE BORRA.
 *                    Es el unico veredicto que muta la base.
 *   reintentable   — falla del transporte (5xx, cuota, red). No se borra nada:
 *                    borrar por un 503 dejaria al supervisor sin telefono
 *                    registrado justo despues de un corte del proveedor.
 */
export type PushVerdict = 'entregado' | 'token-invalido' | 'reintentable';

export interface PushResult {
  readonly token: string;
  readonly verdict: PushVerdict;
  /** Codigo del transporte para el log. Nunca el token ni datos del usuario. */
  readonly detail?: string;
}

export interface PushProvider {
  /**
   * Debe devolver un resultado por cada token recibido y en cualquier caso NO
   * lanzar por un token individual: una falla suelta se expresa como veredicto,
   * no como excepcion. Lanzar se reserva para lo que invalida el lote completo
   * (credenciales rechazadas, por ejemplo).
   */
  send(
    tokens: readonly string[],
    notification: PushNotification,
    tenantId: string,
  ): Promise<readonly PushResult[]>;
}
