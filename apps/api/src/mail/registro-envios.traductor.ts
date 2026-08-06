import type { Env } from '../config/env';
import { TraductorContratoInterno } from './registro-envios.traductor-interno';
import type { EventoEntrega } from './registro-envios.types';

/**
 * Traductor del webhook del proveedor de correo (#220).
 *
 * QUE TRADUCE
 * Del formato del proveedor al vocabulario del registro: `EventoEntrega`, que
 * son cuatro campos. Nada mas del sistema conoce el formato de nadie — esa es
 * la razon de que esto sea una interfaz y no una funcion, y por que el proveedor
 * de correo (decision abierta #9) se puede seguir postergando sin que el resto
 * del carril quede a medias. Mismo patron que `MailProvider` y `PushProvider`:
 * el codigo va contra el contrato y elegir despues cuesta un archivo.
 *
 * EL TRADUCTOR TAMBIEN VERIFICA LA FIRMA, Y NO ES UN DETALLE DE IMPLEMENTACION
 * El endpoint es publico: no hay sesion, y lo unico que autoriza es la firma.
 * Pero firmar es justo lo que cada proveedor hace distinto —cabecera propia,
 * algoritmo propio, y varios firman los BYTES del cuerpo, no sus campos—, asi
 * que verificar aca afuera obligaria al controlador a conocer un formato. Por
 * eso `traducir()` devuelve o los eventos o el motivo del rechazo: quien sabe
 * leer la firma del proveedor es el mismo que sabe leer su cuerpo.
 *
 * DEVUELVE UNA LISTA PORQUE LOS PROVEEDORES MANDAN LOTES. Un webhook puede
 * traer varios eventos de varios mensajes en un solo POST.
 *
 * UNA LISTA VACIA NO ES UN ERROR. Los proveedores reportan tambien aperturas,
 * clics y diferimientos, que a este registro no le dicen nada. Eso es
 * `{ ok: true, eventos: [] }` y responde 202: rechazarlo haria que el proveedor
 * reintentara para siempre un evento que nunca vamos a querer.
 *
 * ES ASINCRONO AUNQUE HOY NADIE ESPERE NADA. Verificar la firma de algunos
 * proveedores exige traer su certificado de firma por HTTP (SNS es el caso
 * conocido). Dejarlo sincrono ahora obligaria a cambiar la interfaz, el
 * controlador y sus pruebas el dia que se elija uno de esos.
 */
export const TRADUCTOR_WEBHOOK = Symbol('TRADUCTOR_WEBHOOK');

/** La peticion tal como llego, sin interpretar. */
export interface PeticionWebhook {
  /** Cabeceras en minusculas, tal como las entrega Express. */
  readonly cabeceras: Readonly<Record<string, string | string[] | undefined>>;
  /** El cuerpo ya parseado por Nest. Es `unknown` porque no es nuestro formato. */
  readonly cuerpo: unknown;
  /**
   * Los bytes del cuerpo tal como llegaron, para los proveedores que firman el
   * cuerpo crudo. Solo existe si la aplicacion levanta con `rawBody: true`, y
   * hoy NO lo hace: el parche de main.ts esta escrito en INTEGRACION.md y se
   * aplica junto con el primer traductor que lo necesite, no antes, porque
   * guardar el buffer sin parsear cuesta memoria en TODAS las peticiones de la
   * API. El traductor que lo necesite y no lo encuentre devuelve
   * `cuerpo_invalido` en vez de verificar contra un JSON re-serializado, que no
   * es el mismo byte a byte y daria una firma valida por inexistente.
   */
  readonly cuerpoCrudo?: Buffer | undefined;
  /** Instante de recepcion en ms. Se pasa para que la ventana de frescura sea comprobable. */
  readonly recibidoEnMs: number;
}

/**
 * Por que se rechaza una peticion.
 *
 * `sin_secreto` es el unico que NO es culpa de quien llama: el canal esta
 * apagado de este lado y el endpoint responde 503, no 403. Los demas son 403 sin
 * distinguir cual: a un endpoint publico no se le cuenta a un desconocido si lo
 * que fallo fue el formato o la firma.
 */
export type MotivoRechazo =
  | 'sin_secreto'
  | 'cuerpo_invalido'
  | 'firma_ausente'
  | 'firma_invalida'
  | 'vencida';

export type Traduccion =
  | { readonly ok: true; readonly eventos: readonly EventoEntrega[] }
  | { readonly ok: false; readonly motivo: MotivoRechazo };

export interface TraductorWebhookCorreo {
  /** Nombre del traductor, para el log. Nunca el secreto ni la marca en claro. */
  readonly nombre: string;
  traducir(peticion: PeticionWebhook): Promise<Traduccion>;
}

export type TraductorEnvironment = Pick<Env, 'NOTIF_WEBHOOK_DRIVER' | 'NOTIF_WEBHOOK_SECRET'>;

/**
 * Arma el traductor que declara el entorno.
 *
 * HAY UN SOLO VALOR Y ES A PROPOSITO. El proveedor de correo no esta elegido
 * (#9), y el repo ya decidio no escribir adaptadores por marca antes de que haya
 * una razon concreta (ver el comentario de MAIL_DRIVER en config/env.ts). El
 * unico traductor que se puede escribir hoy sin inventarse el formato de nadie
 * es `interno`: el contrato de ingesta que definimos nosotros, que un relay de
 * una pagina alimenta desde el webhook del proveedor que sea.
 *
 * COMO SE AGREGA EL SIGUIENTE: un valor mas en el enum de `NOTIF_WEBHOOK_DRIVER`,
 * un archivo `registro-envios.traductor-<marca>.ts` que implemente
 * `TraductorWebhookCorreo`, y un `case` aca. Nada mas cambia: ni el controlador,
 * ni el servicio, ni la tabla.
 *
 * NO EXIGE EL SECRETO PARA CONSTRUIR, a diferencia de `createPushProvider` con
 * las credenciales de FCM. Sin secreto el canal existe pero falla CERRADO en
 * cada peticion, con 503; negarse a construir dejaria la API sin arrancar por un
 * canal de notificaciones sin configurar, que es justo el cambio —"un aviso que
 * no llega" por "un producto que no levanta"— que el repo ya decidio no hacer
 * con PUSH_DRIVER.
 */
export function crearTraductorWebhook(env: TraductorEnvironment): TraductorWebhookCorreo {
  switch (env.NOTIF_WEBHOOK_DRIVER) {
    case 'interno':
      return new TraductorContratoInterno(env.NOTIF_WEBHOOK_SECRET);
    default: {
      // Exhaustivo: agregar un driver al enum y olvidar el `case` no compila,
      // en vez de arrancar y fallar en el primer webhook.
      const noContemplado: never = env.NOTIF_WEBHOOK_DRIVER;
      throw new Error(`NOTIF_WEBHOOK_DRIVER sin traductor: ${String(noContemplado)}`);
    }
  }
}
