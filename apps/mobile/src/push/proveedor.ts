/**
 * Puerto del lado de la app, espejo de `PushProvider` en la API.
 *
 * POR QUE TAMBIEN AQUI HAY UN PUERTO: el proveedor de push no esta decidido
 * (#113) y `apps/mobile/package.json` no incorpora hoy ninguna dependencia de
 * Firebase ni de notificaciones. Todo lo que este modulo hace —pedir el
 * permiso, registrar el token, resolver el deep link— es logica que no depende
 * del transporte, y se prueba y se revisa sin haber elegido nada.
 *
 * Lo unico que falta el dia que se decida es una implementacion de esta
 * interfaz. En INTEGRACION.md esta el detalle de que paquete la cumple y que
 * hay que agregar al proyecto Android.
 */

export type EstadoPermisoNotificaciones =
  | 'concedido'
  | 'denegado'
  /**
   * El dialogo del sistema ya no se muestra: Android lo bloquea tras dos
   * rechazos, y en Android 12 y anteriores nunca existio —las notificaciones se
   * apagan desde Ajustes—. La unica salida es Ajustes, y la interfaz tiene que
   * ofrecer ESE camino en vez de repetir un pedido que no va a aparecer.
   */
  | 'denegado-definitivo';

/** Baja de suscripcion. Se llama al desmontar; nunca deja el listener colgado. */
export type Desuscribir = () => void;

export interface ProveedorPushNativo {
  /** Estado actual, sin abrir ningun dialogo. */
  estadoPermiso(): Promise<EstadoPermisoNotificaciones>;

  /**
   * Abre el dialogo del sistema (Android 13+). En versiones anteriores no hay
   * dialogo: debe resolver con el estado real sin mostrar nada.
   */
  solicitarPermiso(): Promise<EstadoPermisoNotificaciones>;

  /**
   * Token del dispositivo. `null` cuando todavia no hay: sin permiso, sin
   * servicios de Google en el equipo, o sin red en el primer arranque.
   */
  obtenerToken(): Promise<string | null>;

  /**
   * El sistema rota el token sin avisar al usuario. Sin esto, un supervisor
   * deja de recibir alertas y nadie se entera hasta el panico que no sono.
   */
  alRotarToken(escuchar: (token: string) => void): Desuscribir;

  /**
   * El usuario TOCO la notificacion. Incluye el arranque en frio: si la app
   * estaba cerrada, la implementacion debe entregar tambien ese primer toque.
   */
  alTocarNotificacion(escuchar: (datos: Record<string, unknown>) => void): Desuscribir;
}
