/**
 * Push y deep links del shell Android (#113). Ver README.md de esta carpeta.
 *
 * El unico archivo que se copia a otro proyecto es `deep-link.ts`: es el
 * contrato compartido con la API y no importa nada, igual que el protocolo del
 * puente.
 */
export {
  DEEP_LINK_MAJOR,
  DEEP_LINK_MAJORS_SOPORTADOS,
  DEEP_LINK_MINOR,
  RUTAS_DEEP_LINK,
  datosDeDeepLink,
  leerDeepLink,
  rutaDePortal,
  type DeepLink,
  type DestinoDeepLink,
  type LecturaDeepLink,
} from './deep-link';

export { crearPushDeApp, type OpcionesPushDeApp, type PushDeApp } from './manejador';

export {
  consultarPermisoNotificaciones,
  pideDialogoExplicito,
  solicitarPermisoNotificaciones,
} from './permiso';

export {
  darDeBajaDispositivo,
  registrarDispositivo,
  type OpcionesRegistro,
  type ResultadoRegistro,
} from './registro';

export type {
  Desuscribir,
  EstadoPermisoNotificaciones,
  ProveedorPushNativo,
} from './proveedor';
