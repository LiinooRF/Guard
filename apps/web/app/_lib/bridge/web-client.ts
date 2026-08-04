/**
 * Lado PORTAL del puente. Es el archivo que consume `apps/web` dentro del
 * WebView; vive aca porque el contrato es uno solo y separarlo es como se
 * desincroniza.
 *
 * No usa `window` ni tipos del DOM a proposito: asi compila igual en el
 * tsconfig de Expo y en el de Next.js, y se puede copiar sin ajustes.
 *
 * SI NO HAY PUENTE, NO ES UN ERROR. El mismo portal se abre en el navegador de
 * escritorio del ADMIN y del SUPERVISOR, donde no existe shell nativo. En ese
 * caso `conectar()` responde `sin-puente` y la interfaz debe ofrecer el camino
 * de respaldo (etiqueta QR por camara web), no un mensaje de fallo.
 */
import {
  MAX_BYTES_MENSAJE,
  armarSobre,
  leerMensajeShell,
  type CodigoErrorEscaneo,
  type EstadoConexionPayload,
  type IncompatiblePayload,
  type ListoPayload,
  type MensajePortal,
  type MensajeShell,
  type Permiso,
  type ResultadoEscaneoPayload,
  type ResultadoPermisoPayload,
  type RutaOfflinePayload,
  type EncolarSyncPayload,
} from './protocol';

/**
 * LO QUE ESTE PORTAL EXIGE DEL SHELL. Se escribe a mano y NO se deriva de
 * `PROTOCOLO_MAJOR`.
 *
 * Derivarlo seria comodo y romperia produccion: al agregar un mensaje nuevo, el
 * portal empezaria a exigir la version del dia siguiente y todos los guardias
 * con la app anterior —que son todos, durante semanas— se quedarian sin
 * escanear. Este numero solo sube cuando Play Console muestra que el parque
 * instalado ya tiene esa version, y bajar de version en el portal es un deploy;
 * bajar la app instalada no existe.
 */
export const REQUISITO_PORTAL = { major: 1, minMinor: 0 } as const;

/** Identificador del build del portal, solo para diagnostico en soporte. */
export const PORTAL_BUILD = 'apps/web';

const MS_ESPERA_DEFECTO = 30_000;
const MS_ESCANEO_DEFECTO = 60_000;

interface PuenteInyectado {
  readonly protocolo: string;
  readonly major: number;
  readonly minor: number;
  readonly soportados: readonly number[];
  readonly appVersion: string;
  enviar(json: string): void;
  suscribir(fn: (json: string) => void): () => void;
}

function puenteInyectado(): PuenteInyectado | undefined {
  const global = globalThis as unknown as { __voxiaPuente?: PuenteInyectado };
  const candidato = global.__voxiaPuente;
  return candidato !== undefined && candidato.protocolo === 'voxia.bridge' ? candidato : undefined;
}

export type EstadoPuente =
  | { readonly clase: 'sin-puente' }
  | { readonly clase: 'listo'; readonly info: ListoPayload }
  | { readonly clase: 'incompatible'; readonly info: IncompatiblePayload };

/** Error de escaneo del lado del portal, con el codigo cerrado del contrato. */
export class ErrorEscaneoPortal extends Error {
  constructor(
    readonly codigo: CodigoErrorEscaneo,
    mensaje: string,
    readonly reintentable: boolean,
  ) {
    super(mensaje);
    this.name = 'ErrorEscaneoPortal';
  }
}

interface Pendiente {
  readonly resolver: (mensaje: MensajeShell) => void;
  readonly rechazar: (error: Error) => void;
  readonly temporizador: ReturnType<typeof setTimeout>;
}

export interface ClientePuente {
  /** Hace el saludo y resuelve el veredicto de compatibilidad. */
  readonly conectar: () => Promise<EstadoPuente>;
  readonly escanearNfc: (opciones?: {
    readonly timeoutMs?: number;
    readonly titulo?: string;
  }) => Promise<ResultadoEscaneoPayload>;
  readonly cancelarEscaneo: () => void;
  /**
   * `divulgacionMostrada` es una afirmacion con consecuencias: el shell rechaza
   * el pedido de `ubicacion-segundo-plano` si viene en `false`. Ponerlo en
   * `true` sin haber mostrado el aviso es lo que hace que Play rechace la ficha.
   */
  readonly pedirPermiso: (
    permiso: Permiso,
    divulgacionMostrada: boolean,
  ) => Promise<ResultadoPermisoPayload>;
  readonly consultarPermiso: (permiso: Permiso) => Promise<ResultadoPermisoPayload>;
  readonly estadoConexion: () => Promise<EstadoConexionPayload>;
  readonly guardarRutaOffline: (ruta: RutaOfflinePayload) => Promise<string>;
  readonly borrarRutaOffline: () => Promise<void>;
  readonly encolarSync: (payload: EncolarSyncPayload) => Promise<boolean>;
  readonly sincronizarCola: () => Promise<{ processed: number; pending: number }>;
  /** Cambios empujados por el shell. Devuelve la funcion para desuscribirse. */
  readonly alCambiarConexion: (fn: (estado: EstadoConexionPayload) => void) => () => void;
  readonly desconectar: () => void;
}

export function crearClientePuente(): ClientePuente {
  const puente = puenteInyectado();
  const pendientes = new Map<string, Pendiente>();
  const oyentesConexion = new Set<(estado: EstadoConexionPayload) => void>();
  let desuscribir: (() => void) | undefined;
  let incompatible: IncompatiblePayload | undefined;

  function recibir(crudo: string): void {
    const lectura = leerMensajeShell(crudo);
    if (!lectura.ok) {
      return;
    }
    const mensaje = lectura.mensaje;

    if (mensaje.type === 'connectivity.state' && mensaje.replyTo === undefined) {
      for (const oyente of oyentesConexion) {
        oyente(mensaje.payload);
      }
      return;
    }

    if (mensaje.type === 'incompatible') {
      incompatible = mensaje.payload;
    }

    if (mensaje.replyTo === undefined) {
      return;
    }
    const pendiente = pendientes.get(mensaje.replyTo);
    if (pendiente === undefined) {
      return;
    }
    pendientes.delete(mensaje.replyTo);
    clearTimeout(pendiente.temporizador);
    pendiente.resolver(mensaje);
  }

  function asegurarSuscripcion(): void {
    if (puente !== undefined && desuscribir === undefined) {
      desuscribir = puente.suscribir(recibir);
    }
  }

  /**
   * El tipo del payload sale del propio catalogo de mensajes: mandar
   * `nfc.scan.start` con el payload de `permission.request` no compila. Es la
   * unica forma de que este archivo sea el contrato y no una copia amable de el.
   */
  function pedir<T extends MensajePortal['type']>(
    type: T,
    payload: Extract<MensajePortal, { type: T }>['payload'],
    msEspera: number,
  ): Promise<MensajeShell> {
    if (puente === undefined) {
      return Promise.reject(new Error('sin-puente'));
    }
    if (incompatible !== undefined) {
      return Promise.reject(new Error('puente-incompatible'));
    }
    asegurarSuscripcion();

    const sobre = armarSobre(type, payload, { prefijo: 'web' });
    const json = JSON.stringify(sobre);
    if (json.length * 2 > MAX_BYTES_MENSAJE) {
      return Promise.reject(new Error('mensaje-demasiado-grande'));
    }

    return new Promise<MensajeShell>((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        pendientes.delete(sobre.id);
        rechazar(new Error('sin-respuesta-del-shell'));
      }, msEspera);
      pendientes.set(sobre.id, { resolver, rechazar, temporizador });
      puente.enviar(json);
    });
  }

  return {
    conectar: async () => {
      if (puente === undefined) {
        return { clase: 'sin-puente' as const };
      }
      const respuesta = await pedir(
        'hello',
        { portalBuild: PORTAL_BUILD, requiere: REQUISITO_PORTAL },
        MS_ESPERA_DEFECTO,
      );
      if (respuesta.type === 'ready') {
        return { clase: 'listo' as const, info: respuesta.payload };
      }
      if (respuesta.type === 'incompatible') {
        return { clase: 'incompatible' as const, info: respuesta.payload };
      }
      throw new Error('respuesta-inesperada-al-saludo');
    },

    escanearNfc: async (opciones) => {
      const timeoutMs = opciones?.timeoutMs ?? MS_ESCANEO_DEFECTO;
      const payload =
        opciones?.titulo === undefined ? { timeoutMs } : { timeoutMs, titulo: opciones.titulo };
      // Se espera un poco mas que el shell para que gane siempre el error
      // tipado del shell y no un timeout generico sin codigo.
      const respuesta = await pedir('nfc.scan.start', payload, timeoutMs + 5_000);
      if (respuesta.type === 'nfc.scan.result') {
        return respuesta.payload;
      }
      if (respuesta.type === 'nfc.scan.error') {
        throw new ErrorEscaneoPortal(
          respuesta.payload.codigo,
          respuesta.payload.mensaje,
          respuesta.payload.reintentable,
        );
      }
      throw new ErrorEscaneoPortal('error-desconocido', 'Respuesta inesperada del shell.', true);
    },

    cancelarEscaneo: () => {
      if (puente === undefined) {
        return;
      }
      puente.enviar(JSON.stringify(armarSobre('nfc.scan.cancel', {}, { prefijo: 'web' })));
    },

    pedirPermiso: async (permiso, divulgacionMostrada) => {
      const respuesta = await pedir(
        'permission.request',
        { permiso, divulgacionMostrada },
        MS_ESPERA_DEFECTO,
      );
      if (respuesta.type === 'permission.result') {
        return respuesta.payload;
      }
      if (respuesta.type === 'error') {
        throw new Error(respuesta.payload.codigo);
      }
      throw new Error('respuesta-inesperada-al-permiso');
    },

    consultarPermiso: async (permiso) => {
      const respuesta = await pedir('permission.query', { permiso }, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'permission.result') {
        throw new Error('respuesta-inesperada-al-permiso');
      }
      return respuesta.payload;
    },

    estadoConexion: async () => {
      const respuesta = await pedir('connectivity.query', {}, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'connectivity.state') {
        throw new Error('respuesta-inesperada-a-conectividad');
      }
      return respuesta.payload;
    },

    guardarRutaOffline: async (ruta) => {
      const respuesta = await pedir('offline.route.save', ruta, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'offline.route.saved') {
        throw new Error('respuesta-inesperada-al-guardar-ruta');
      }
      return respuesta.payload.savedAt;
    },

    borrarRutaOffline: async () => {
      const respuesta = await pedir('offline.route.clear', {}, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'offline.route.cleared') {
        throw new Error('respuesta-inesperada-al-borrar-ruta');
      }
    },

    encolarSync: async (payload) => {
      const respuesta = await pedir('sync.queue.enqueue', payload, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'sync.queue.enqueued') throw new Error('respuesta-sync-inesperada');
      return respuesta.payload.inserted;
    },

    sincronizarCola: async () => {
      const respuesta = await pedir('sync.queue.flush', {}, MS_ESPERA_DEFECTO);
      if (respuesta.type !== 'sync.queue.flushed') throw new Error('respuesta-sync-inesperada');
      return respuesta.payload;
    },

    alCambiarConexion: (fn) => {
      asegurarSuscripcion();
      oyentesConexion.add(fn);
      return () => oyentesConexion.delete(fn);
    },

    desconectar: () => {
      for (const pendiente of pendientes.values()) {
        clearTimeout(pendiente.temporizador);
        pendiente.rechazar(new Error('puente-cerrado'));
      }
      pendientes.clear();
      oyentesConexion.clear();
      desuscribir?.();
      desuscribir = undefined;
    },
  };
}
