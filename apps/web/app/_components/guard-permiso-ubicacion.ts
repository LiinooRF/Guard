import type { EstadoPermiso, ResultadoPermisoPayload } from '../_lib/bridge/protocol';

/**
 * El cable que faltaba (#275): informar al servidor como quedo el permiso de
 * ubicacion del TELEFONO.
 *
 * El servidor no puede averiguarlo solo y lo exige antes de iniciar ronda
 * (`gps-policy.service.ts`): sin este reporte, un guardia nuevo con todo bien
 * hecho —aviso aceptado, permiso de Android concedido— se queda mirando
 * "el telefono todavia no confirmo el permiso" sin ninguna salida. Las tres
 * piezas existian (el endpoint, el puente, el cliente) y nadie las conectaba;
 * la prueba extrema del 8-ago lo dejo a la vista.
 *
 * Dos momentos, dos verbos distintos:
 *
 * - **Al cargar la pantalla**: `consultar` (permission.query). No abre ningun
 *   dialogo: solo lee el estado actual y lo reporta. Cubre al guardia que ya
 *   concedio el permiso —hoy mismo, o despues en Ajustes— y al que lo revoco.
 * - **Tras aceptar el aviso**: `pedir` (permission.request). Ese SI puede abrir
 *   el dialogo del sistema, y por eso solo ocurre ahi: el aviso recien aceptado
 *   es la divulgacion destacada que Google Play exige ANTES del dialogo de
 *   ubicacion. Pedirlo al cargar, sin aviso mediante, es causal de rechazo en
 *   la revision de Play.
 *
 * TODO estado se reporta, tambien el denegado: el supervisor tiene que saber
 * por que un guardia no comparte ubicacion, y "denegado" es un dato operativo,
 * no un fallo. El unico resultado que no viaja es no poder hablar con el puente
 * (fuera del WebView no hay telefono que reportar).
 */

/** Lo que este modulo necesita del mundo; se inyecta para poder probarlo. */
export interface DepsReportePermiso {
  /** permission.query del puente: lee sin abrir dialogos. */
  consultar: (permiso: 'ubicacion') => Promise<ResultadoPermisoPayload>;
  /** POST /geo/permission con la sesion del guardia. Debe lanzar si no es 2xx. */
  reportar: (estado: EstadoApi, deviceInfo: string) => Promise<void>;
  /** Marca del equipo SIN datos de la persona, p. ej. "android api 34 · app 1.2.0". */
  deviceInfo: string;
}

export type EstadoApi = 'concedido' | 'solo_primer_plano' | 'denegado' | 'no_disponible';

export type ResultadoReporte =
  | { hecho: true; estado: EstadoApi }
  | { hecho: false; motivo: 'sin-puente' | 'reporte-rechazado' };

/**
 * Traduce el estado del puente al contrato del servidor
 * (`GPS_PERMISSION_STATES`, espejo del CHECK de `gps_permission_reports`).
 *
 * 'denegado-definitivo' viaja como 'denegado': para el servidor son lo mismo
 * —este telefono no entrega ubicacion— y la diferencia (si el dialogo puede
 * volver a mostrarse) es asunto de la INTERFAZ, que debe ofrecer el boton de
 * Ajustes en vez de repetir un pedido que ya no aparece.
 */
export function traducirEstadoPermiso(estado: EstadoPermiso): EstadoApi {
  switch (estado) {
    case 'concedido':
      return 'concedido';
    case 'denegado':
    case 'denegado-definitivo':
      return 'denegado';
    case 'no-aplica':
      return 'no_disponible';
  }
}

/**
 * Consulta el estado al puente y lo reporta al servidor. No abre dialogos.
 *
 * Falla BLANDO a proposito: esto corre al cargar la pantalla del guardia, y un
 * puente que no responde (portal abierto en un navegador de escritorio) o un
 * reporte rechazado no pueden tumbar la ronda. El resultado dice que paso para
 * que quien llama decida si avisa.
 */
export async function reportarPermisoUbicacion(
  deps: DepsReportePermiso,
): Promise<ResultadoReporte> {
  let resultado: ResultadoPermisoPayload;
  try {
    resultado = await deps.consultar('ubicacion');
  } catch {
    return { hecho: false, motivo: 'sin-puente' };
  }

  const estado = traducirEstadoPermiso(resultado.estado);
  try {
    await deps.reportar(estado, deps.deviceInfo);
  } catch {
    return { hecho: false, motivo: 'reporte-rechazado' };
  }
  return { hecho: true, estado };
}

/**
 * El nombre del evento con el que el flujo de consentimiento avisa "el guardia
 * acaba de aceptar el aviso". Lo dispara `consentimiento-aviso.tsx` y lo
 * escucha `use-guard-bridge.ts`, que en ese momento —y solo en ese— hace el
 * `permission.request` con la divulgacion ya mostrada.
 *
 * Un evento del DOM y no una prop, porque entre los dos componentes hay tres
 * capas que no tienen por que enterarse del permiso de ubicacion.
 */
export const EVENTO_CONSENTIMIENTO_ACEPTADO = 'sentrycore:consentimiento-aceptado';
