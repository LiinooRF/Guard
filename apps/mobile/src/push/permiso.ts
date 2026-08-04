import { Platform } from 'react-native';

import type { ResultadoPermisoPayload } from '../bridge/protocol';
import type { EstadoPermisoNotificaciones, ProveedorPushNativo } from './proveedor';

/**
 * Permiso de notificaciones.
 *
 * ANDROID 13+ LO PIDE EXPLICITO. Antes de API 33 la app quedaba habilitada al
 * instalarse; desde 33 `POST_NOTIFICATIONS` es un permiso de ejecucion y, si no
 * se pide, el sistema NO muestra nada y tampoco avisa que lo esta ocultando. El
 * sintoma en terreno es exactamente el peor: el supervisor jura que la app no
 * funciona porque el panico nunca sono.
 *
 * DOS RECHAZOS Y SE ACABO. Android deja de mostrar el dialogo despues de dos
 * negativas, y desde ahi la unica salida es Ajustes. Por eso este modulo no
 * pide el permiso al abrir la app: pedirlo en una pantalla de carga, sin que la
 * persona sepa para que, es la forma mas eficiente de quemar los dos intentos.
 * Se pide cuando hay contexto —al entrar al panel de monitoreo, tras explicar
 * que es para las alertas de panico— y esa decision es del portal, no de este
 * archivo.
 *
 * Devuelve el mismo `ResultadoPermisoPayload` del puente para que esto pueda
 * ser directamente el manejador de `permission.request` con
 * `permiso: 'notificaciones'`, sin agregar ningun mensaje nuevo al protocolo.
 */

/** Desde esta version de Android el permiso se pide con dialogo. */
const ANDROID_PERMISO_EXPLICITO = 33;

function comoPayload(estado: EstadoPermisoNotificaciones): ResultadoPermisoPayload {
  return {
    permiso: 'notificaciones',
    estado,
    // Solo se puede volver a pedir cuando el dialogo todavia aparece. Si no,
    // la interfaz debe ofrecer el boton que abre Ajustes.
    puedeVolverAPedir: estado === 'denegado',
  };
}

export function pideDialogoExplicito(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= ANDROID_PERMISO_EXPLICITO;
}

/**
 * Consulta sin abrir ningun dialogo. Es lo que se usa para pintar el estado en
 * pantalla: consultar no gasta intentos, pedir si.
 */
export async function consultarPermisoNotificaciones(
  proveedor: ProveedorPushNativo,
): Promise<ResultadoPermisoPayload> {
  return comoPayload(await proveedor.estadoPermiso());
}

/**
 * Pide el permiso si hace falta.
 *
 * En Android 12 y anteriores no hay dialogo que abrir: si el estado es
 * `denegado` es porque las notificaciones estan apagadas en Ajustes, y se
 * devuelve `denegado-definitivo` para que la interfaz mande ahi en vez de
 * quedarse esperando un dialogo que ese sistema no tiene.
 */
export async function solicitarPermisoNotificaciones(
  proveedor: ProveedorPushNativo,
): Promise<ResultadoPermisoPayload> {
  const actual = await proveedor.estadoPermiso();
  if (actual === 'concedido' || actual === 'denegado-definitivo') {
    return comoPayload(actual);
  }

  if (!pideDialogoExplicito()) {
    return comoPayload('denegado-definitivo');
  }

  return comoPayload(await proveedor.solicitarPermiso());
}
