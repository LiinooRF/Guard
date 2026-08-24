/**
 * Contrato del puente nativo <-> WebView de SentryCore.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE ARCHIVO ESTA VERSIONADO Y POR QUE IMPORTA TANTO
 * ---------------------------------------------------------------------------
 * Los dos lados del puente se despliegan a velocidades incompatibles:
 *
 *   - El portal web se despliega en minutos y se revierte en minutos. Al
 *     recargar, el guardia ya tiene la version nueva.
 *   - El shell nativo pasa por revision de Play Store y despues depende de que
 *     cada guardia actualice. Semanas, no minutos. Y no se revierte: una
 *     version publicada queda instalada en telefonos que no controlamos.
 *
 * Consecuencia operativa, que es la regla dura de este archivo:
 *
 *   **El portal se adapta al shell instalado, nunca al reves.** El portal no
 *   puede exigir una version del protocolo mas nueva que la del shell mas
 *   viejo que todavia esta en uso real. Si la exige, el guardia abre la app en
 *   medio de la ronda, no puede escanear, y eso NO se arregla con un deploy.
 *
 * Por eso el shell soporta un RANGO de versiones mayores (`MAJORS_SOPORTADOS`)
 * y no solo la ultima: es la ventana de gracia mientras el parque de telefonos
 * se actualiza.
 *
 * ---------------------------------------------------------------------------
 * COMO SE VERSIONA
 * ---------------------------------------------------------------------------
 *   MAJOR  sube cuando un mensaje existente cambia de forma o desaparece
 *          (rompe). Requiere ventana de convivencia: el shell nuevo soporta
 *          MAJOR y MAJOR-1 hasta que el parque instalado se renueve.
 *   MINOR  sube cuando se AGREGA un mensaje o un campo opcional (no rompe).
 *          El portal puede pedir un minimo de minor y degradar si no lo hay.
 *
 * Ninguno de los dos lados adivina: el portal declara lo que necesita en el
 * mensaje `hello` y el shell responde `ready` o `incompatible`.
 *
 * ---------------------------------------------------------------------------
 * ESTE ARCHIVO NO IMPORTA NADA
 * ---------------------------------------------------------------------------
 * Ni React Native ni Node ni el DOM. Es el mismo archivo para los dos lados y
 * se copia tal cual al portal web. Si le agregas un import, dejaste de poder
 * compartirlo y el contrato se desincroniza en silencio, que es exactamente el
 * problema que este archivo existe para evitar.
 */

export const PUENTE = 'sentrycore.bridge' as const;

/**
 * Version que habla ESTE build del shell.
 *
 * MINOR 4 agrega la familia `qr.*` (respaldo por camara, issues #226 y #227).
 * MINOR 5 agrega la familia `track.*` (traza en vivo, #280): el portal pide
 *         muestrear mientras la ronda esta en curso y el shell entrega cada
 *         posicion; el portal la sube con su sesion. Un shell viejo la
 *         descarta por tipo desconocido y el portal degrada sin traza.
 * Es aditivo: el portal viejo no la pide y el shell viejo nunca la recibe, asi
 * que ningun telefono instalado se rompe mientras el parque se actualiza.
 */
export const PROTOCOLO_MAJOR = 1;
export const PROTOCOLO_MINOR = 5;

/**
 * Versiones mayores que este shell todavia entiende. Se agrega la anterior al
 * subir de mayor y se retira recien cuando las metricas de Play muestran que el
 * parque instalado ya migro.
 */
export const MAJORS_SOPORTADOS: readonly number[] = [1];

/**
 * Tope de tamaño de un mensaje. `postMessage` viaja como string y el WebView lo
 * copia entero: un mensaje gigante desde una pagina comprometida cuelga la app.
 * Ningun mensaje legitimo del contrato se acerca a esto — el UID de una etiqueta
 * NFC son 64 caracteres como mucho. Las fotos NO van por el puente.
 */
export const MAX_BYTES_MENSAJE = 64 * 1024;

// ---------------------------------------------------------------------------
// Sobre
// ---------------------------------------------------------------------------

export interface Sobre<T extends string, P> {
  /** Discriminante de protocolo: descarta mensajes de terceros en el WebView. */
  readonly p: typeof PUENTE;
  /** Version mayor con la que se emitio el mensaje. */
  readonly v: number;
  /** Identificador del mensaje. Correlaciona pedido y respuesta. */
  readonly id: string;
  /** `id` del mensaje que este responde. Ausente si no responde a nada. */
  readonly replyTo?: string;
  readonly type: T;
  readonly payload: P;
  /** Hora del emisor, ISO-8601. Solo para diagnostico. */
  readonly ts: string;
}

// ---------------------------------------------------------------------------
// Portal -> shell
// ---------------------------------------------------------------------------

export type Permiso =
  | 'nfc'
  | 'camara'
  | 'ubicacion'
  | 'ubicacion-segundo-plano'
  | 'notificaciones';

export interface HolaPayload {
  /** Identificador del build del portal. Solo diagnostico, no decide nada. */
  readonly portalBuild: string;
  /** Lo que el portal NECESITA para funcionar. Aca se decide compatibilidad. */
  readonly requiere: { readonly major: number; readonly minMinor: number };
}

export interface EscaneoNfcPayload {
  /**
   * Corte del escaneo. El shell cancela la sesion NFC y responde
   * `nfc.scan.error` con `timeout`. Sin tope, la antena queda encendida
   * gastando bateria de un turno de 8 horas.
   */
  readonly timeoutMs: number;
  /** Texto que el shell muestra en su hoja nativa de escaneo. */
  readonly titulo?: string;
}

/**
 * Respaldo por QR (#226, #227). Se declara aparte de `EscaneoNfcPayload` aunque
 * hoy tengan la misma forma: lo que se apaga al vencer el plazo no es la antena
 * sino la CAMARA, que ademas de bateria deja una vista previa encima de la
 * pantalla del guardia hasta que alguien la cierra.
 */
export interface EscaneoQrPayload {
  readonly timeoutMs: number;
  /** Texto que el shell muestra sobre la vista previa de la camara. */
  readonly titulo?: string;
}

export interface PedirPermisoPayload {
  readonly permiso: Permiso;
  /**
   * El portal declara que YA mostro la divulgacion destacada. Para
   * `ubicacion-segundo-plano` el shell RECHAZA la solicitud si esto viene en
   * `false`: pedir ese permiso sin divulgacion previa es causal de rechazo en
   * Play Store, y el puente es el ultimo lugar donde se puede impedir.
   */
  readonly divulgacionMostrada: boolean;
}

export interface ConsultarPermisoPayload {
  readonly permiso: Permiso;
}

export interface RutaOfflinePayload {
  readonly patrolId: string;
  readonly status: 'pendiente' | 'en_curso';
  readonly siteName: string;
  readonly routeName: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly estimatedDurationMin: number;
  readonly checkpoints: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly isClosingPoint?: boolean;
    readonly tagUids: readonly string[];
  }[];
}

export interface EncolarSyncPayload {
  readonly apiUrl: string;
  readonly portalOrigin: string;
  readonly operation: {
    readonly type: 'scan' | 'event';
    readonly clientId: string;
    readonly patrolId?: string;
    readonly payload: Record<string, unknown>;
    readonly queuedAt: string;
  };
}

export interface RegistrarFirmaPayload {
  readonly apiUrl: string;
  readonly portalOrigin: string;
}

/** El portal pide muestrear la posicion mientras la ronda esta en curso. */
export interface IniciarTrazaPayload {
  /** Cada cuantos segundos. Sale del plan del servidor (GET /geo/policy). */
  readonly intervalSeconds: number;
  /**
   * A donde sube el shell las posiciones que toma con la pantalla apagada.
   *
   * OPCIONALES a proposito: un portal viejo no los manda y el shell se queda
   * con el muestreo de primer plano de siempre. Solo cuando llegan los dos, el
   * shell puede seguir midiendo en segundo plano — y ahi los necesita, porque
   * en ese momento el WebView puede estar dormido y no hay quien suba nada.
   */
  readonly patrolId?: string;
  readonly apiBaseUrl?: string;
}

/**
 * Una posicion del muestreo. La hora es la del telefono AL MUESTREAR
 * (`recordedAt` es la clave del punto en la ronda, ver AppendTrackDto).
 * No lleva datos de la persona: quien es el guardia lo sabe la sesion.
 */
export interface PuntoDeTrazaPayload {
  readonly recordedAt: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM?: number;
}

export type MensajePortal =
  | Sobre<'hello', HolaPayload>
  | Sobre<'nfc.scan.start', EscaneoNfcPayload>
  | Sobre<'nfc.scan.cancel', Record<string, never>>
  | Sobre<'qr.scan.start', EscaneoQrPayload>
  | Sobre<'qr.scan.cancel', Record<string, never>>
  | Sobre<'permission.request', PedirPermisoPayload>
  | Sobre<'permission.query', ConsultarPermisoPayload>
  | Sobre<'offline.route.save', RutaOfflinePayload>
  | Sobre<'offline.route.clear', Record<string, never>>
  | Sobre<'sync.queue.enqueue', EncolarSyncPayload>
  | Sobre<'sync.queue.flush', Record<string, never>>
  | Sobre<'device.signature.register', RegistrarFirmaPayload>
  | Sobre<'connectivity.query', Record<string, never>>
  | Sobre<'track.start', IniciarTrazaPayload>
  | Sobre<'track.stop', Record<string, never>>;

export const TIPOS_PORTAL: readonly MensajePortal['type'][] = [
  'hello',
  'nfc.scan.start',
  'nfc.scan.cancel',
  'qr.scan.start',
  'qr.scan.cancel',
  'permission.request',
  'permission.query',
  'offline.route.save',
  'offline.route.clear',
  'sync.queue.enqueue',
  'sync.queue.flush',
  'device.signature.register',
  'connectivity.query',
  'track.start',
  'track.stop',
];

// ---------------------------------------------------------------------------
// Shell -> portal
// ---------------------------------------------------------------------------

export interface CapacidadesDispositivo {
  /**
   * El equipo trae antena NFC. `false` NO deja al guardia sin ronda: desde el
   * MINOR 4 el portal ofrece el respaldo por QR (`qr.scan.start`). Sigue siendo
   * respaldo y no camino normal — un QR se fotografia y se reusa, la etiqueta
   * pegada hay que ir a tocarla.
   */
  readonly tieneNfc: boolean;
  /** Trae antena pero esta apagada en Ajustes. Se resuelve, no es fatal. */
  readonly nfcActivado: boolean;
  readonly tieneCamara: boolean;
  readonly nivelApiAndroid: number;
}

export interface ListoPayload {
  readonly protocolo: { readonly major: number; readonly minor: number };
  readonly majorsSoportados: readonly number[];
  readonly app: { readonly version: string };
  readonly dispositivo: CapacidadesDispositivo;
}

export type MotivoIncompatible = 'app-antigua' | 'portal-antiguo';

export interface IncompatiblePayload {
  readonly motivo: MotivoIncompatible;
  readonly shell: { readonly major: number; readonly minor: number };
  readonly portalRequiere: { readonly major: number; readonly minMinor: number };
  /** Texto en español listo para mostrar. El portal no lo redacta. */
  readonly mensaje: string;
}

export interface ResultadoEscaneoPayload {
  /** UID de la etiqueta, hexadecimal en mayusculas y sin separadores. */
  readonly uid: string;
  readonly tech: 'nfc';
  /** Hora del telefono al escanear, ISO-8601. */
  readonly scannedAt: string;
  /**
   * Posicion al momento del escaneo, si el shell la tenia disponible. Va aca y
   * no en una consulta aparte porque separarlas abre una ventana en la que el
   * guardia camina entre el escaneo y la lectura del GPS, y la coordenada deja
   * de corresponder al punto de control.
   */
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyM?: number;
  readonly clientScanId?: string;
  readonly deviceId?: string;
  readonly signature?: string;
}

/**
 * Lectura de la etiqueta QR de respaldo (#227).
 *
 * Tipo aparte y no un `tech` mas en `ResultadoEscaneoPayload` porque los dos
 * identificadores no se parecen: el UID NFC es hexadecimal puro y el del QR es
 * el texto impreso en la etiqueta (`VXQ-` + base32). Fundirlos obligaria a
 * aflojar la validacion del UID NFC, que es la evidencia fuerte, para que
 * aceptara guiones y letras — exactamente al reves de lo que conviene.
 */
export interface ResultadoEscaneoQrPayload {
  /** Contenido del QR tal cual, ya filtrado por `esCodigoQrDePunto`. */
  readonly uid: string;
  readonly tech: 'qr';
  /** Hora del telefono al leer el codigo, ISO-8601. */
  readonly scannedAt: string;
  /** Igual que en NFC: la posicion viaja con la lectura, no en otra consulta. */
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyM?: number;
  readonly clientScanId?: string;
  readonly deviceId?: string;
  readonly signature?: string;
}

/**
 * Prefijo con el que la API emite las etiquetas QR (`apps/api/src/qr/qr.service.ts`).
 *
 * Vive en el contrato porque lo necesitan los DOS lados: el shell para seguir
 * mirando cuando entra al cuadro un afiche o una promocion pegada al lado del
 * punto, y el portal para no mandar a la API algo que ya sabe que no resuelve.
 * Si la API cambiara el prefijo, hay que cambiarlo aca y esperar a que el parque
 * de telefonos se actualice: las etiquetas viejas siguen pegadas en la pared.
 */
export const PREFIJO_QR = 'VXQ-';

/** `true` si el texto leido es una etiqueta de punto de este producto. */
export function esCodigoQrDePunto(texto: string): boolean {
  return /^VXQ-[A-Z2-7]{8,56}$/.test(texto);
}

/**
 * Codigos de error del escaneo. Son cerrados a proposito: el portal decide que
 * mostrar segun el codigo y nunca parseando el texto del mensaje.
 *
 * Los tres ultimos son del respaldo por camara y solo viajan en `qr.scan.error`,
 * que un portal anterior al MINOR 4 nunca pide. Asi un shell nuevo no le manda a
 * un portal viejo un codigo que su validador descarta y que lo dejaria esperando
 * una respuesta que nunca llega.
 */
export type CodigoErrorEscaneo =
  | 'nfc-no-disponible'
  | 'nfc-desactivado'
  | 'permiso-denegado'
  | 'cancelado'
  | 'timeout'
  | 'etiqueta-ilegible'
  | 'error-desconocido'
  | 'camara-no-disponible'
  | 'camara-ocupada'
  | 'codigo-ilegible';

export interface ErrorEscaneoPayload {
  readonly codigo: CodigoErrorEscaneo;
  /** Texto en español para el guardia. Sin jerga y sin datos personales. */
  readonly mensaje: string;
  /** `true` si reintentar puede funcionar sin que el usuario cambie nada. */
  readonly reintentable: boolean;
}

export type EstadoPermiso = 'concedido' | 'denegado' | 'denegado-definitivo' | 'no-aplica';

export interface ResultadoPermisoPayload {
  readonly permiso: Permiso;
  readonly estado: EstadoPermiso;
  /**
   * `false` significa que el dialogo del sistema ya no se muestra y la unica
   * salida es Ajustes. El portal debe ofrecer el boton que abre Ajustes en vez
   * de repetir un pedido que no aparecera.
   */
  readonly puedeVolverAPedir: boolean;
}

export type TipoConexion = 'wifi' | 'celular' | 'ninguna' | 'desconocida';

export interface EstadoConexionPayload {
  readonly enLinea: boolean;
  readonly tipo: TipoConexion;
}

export interface RutaOfflineGuardadaPayload {
  readonly patrolId: string;
  readonly savedAt: string;
}

export type CodigoErrorPuente =
  | 'mensaje-invalido'
  | 'mensaje-demasiado-grande'
  | 'origen-no-autorizado'
  | 'tipo-desconocido'
  | 'divulgacion-faltante'
  | 'error-interno';

export interface ErrorPuentePayload {
  readonly codigo: CodigoErrorPuente;
  readonly mensaje: string;
}

export type MensajeShell =
  | Sobre<'ready', ListoPayload>
  | Sobre<'incompatible', IncompatiblePayload>
  | Sobre<'nfc.scan.result', ResultadoEscaneoPayload>
  | Sobre<'nfc.scan.error', ErrorEscaneoPayload>
  | Sobre<'qr.scan.result', ResultadoEscaneoQrPayload>
  | Sobre<'qr.scan.error', ErrorEscaneoPayload>
  | Sobre<'permission.result', ResultadoPermisoPayload>
  | Sobre<'offline.route.saved', RutaOfflineGuardadaPayload>
  | Sobre<'offline.route.cleared', Record<string, never>>
  | Sobre<'sync.queue.enqueued', { readonly clientId: string; readonly inserted: boolean }>
  | Sobre<'sync.queue.flushed', { readonly processed: number; readonly pending: number }>
  | Sobre<'device.signature.registered', { readonly deviceId: string }>
  | Sobre<'connectivity.state', EstadoConexionPayload>
  | Sobre<'track.point', PuntoDeTrazaPayload>
  | Sobre<'error', ErrorPuentePayload>;

export const TIPOS_SHELL: readonly MensajeShell['type'][] = [
  'ready',
  'incompatible',
  'nfc.scan.result',
  'nfc.scan.error',
  'qr.scan.result',
  'qr.scan.error',
  'permission.result',
  'offline.route.saved',
  'offline.route.cleared',
  'sync.queue.enqueued',
  'sync.queue.flushed',
  'device.signature.registered',
  'connectivity.state',
  'track.point',
  'error',
];

/**
 * Nombres reservados en la version 1. Todavia no existen; se anotan para que
 * nadie los reuse con otro significado y para que quede claro que agregarlos es
 * un MINOR (aditivo), no un MAJOR.
 *
 * Las fotos NO viajan por el puente: una foto de 10 MB en base64 dentro de un
 * `postMessage` son ~13 MB de string copiados dos veces. El shell la sube
 * directo a la API — en Android el `fetch` nativo comparte el frasco de cookies
 * del WebView (`ForwardingCookieHandler`), asi que la sesion HttpOnly sirve sin
 * exponer ningun token al JavaScript del portal.
 */
export const RESERVADOS_V1: readonly string[] = [
  'camera.capture',
  'camera.capture.result',
  'location.track.start',
  'location.track.stop',
  'location.track.state',
  'haptics.pulse',
];

// ---------------------------------------------------------------------------
// Compatibilidad
// ---------------------------------------------------------------------------

export type Veredicto =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly motivo: MotivoIncompatible;
      readonly mensaje: string;
    };

/**
 * Decide si este shell puede atender lo que el portal declaro en `hello`.
 *
 * Que hace cada lado cuando NO son compatibles:
 *
 * `app-antigua` — el portal necesita mas de lo que este shell sabe hacer.
 *   Shell: pantalla bloqueante, sin WebView, con boton a Play Store. No se
 *     sigue: dejar entrar a un portal que va a pedir mensajes inexistentes
 *     termina en una app que no responde y en un guardia sin ronda registrada.
 *   Portal: al recibir `incompatible` deja de ofrecer escaneo y muestra el aviso
 *     de actualizar. El respaldo por QR TAMPOCO sirve aca: tambien viaja por el
 *     puente, y el puente es justamente lo que quedo bloqueado. Lo relevante es
 *     que el portal NO puede asumir que el shell le mostro algo.
 *
 * `portal-antiguo` — el portal habla una version mayor que este shell ya retiro
 *   (pasa despues de una reversion del deploy web).
 *   Shell: aviso "el portal de tu empresa esta desactualizado, avisa a soporte"
 *     y permite reintentar; no manda a Play Store, porque actualizar la app no
 *     lo arregla y solo genera un ticket equivocado.
 *   Portal: registra el evento. Es un error de despliegue nuestro, no del
 *     usuario, y hay que verlo en los logs el mismo dia.
 */
export function verificarCompatibilidad(requiere: HolaPayload['requiere']): Veredicto {
  const soportado = MAJORS_SOPORTADOS.includes(requiere.major);

  if (!soportado) {
    const masAlto = MAJORS_SOPORTADOS.reduce((a, b) => (b > a ? b : a), 0);
    if (requiere.major > masAlto) {
      return {
        ok: false,
        motivo: 'app-antigua',
        mensaje:
          'Tu version de SentryCore es muy antigua para este portal. ' +
          'Actualizala desde Google Play para poder escanear.',
      };
    }
    return {
      ok: false,
      motivo: 'portal-antiguo',
      mensaje:
        'El portal de tu empresa quedo en una version antigua. ' +
        'Avisa a soporte: no se soluciona actualizando la app.',
    };
  }

  if (requiere.major === PROTOCOLO_MAJOR && requiere.minMinor > PROTOCOLO_MINOR) {
    return {
      ok: false,
      motivo: 'app-antigua',
      mensaje:
        'Este portal usa una funcion que tu version de la app todavia no tiene. ' +
        'Actualizala desde Google Play.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Serializacion
// ---------------------------------------------------------------------------

export type ResultadoLectura<T> =
  | { readonly ok: true; readonly mensaje: T }
  | { readonly ok: false; readonly codigo: CodigoErrorPuente; readonly detalle: string };

function esSobre(valor: unknown): valor is Sobre<string, unknown> {
  if (typeof valor !== 'object' || valor === null) {
    return false;
  }
  const c = valor as Record<string, unknown>;
  return (
    c['p'] === PUENTE &&
    typeof c['v'] === 'number' &&
    Number.isInteger(c['v']) &&
    typeof c['id'] === 'string' && c['id'].length > 0 && c['id'].length <= 128 &&
    typeof c['type'] === 'string' &&
    typeof c['ts'] === 'string' &&
    typeof c['payload'] === 'object' &&
    c['payload'] !== null
  );
}

function esRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function clavesPermitidas(valor: Record<string, unknown>, claves: readonly string[]): boolean {
  return Object.keys(valor).every((clave) => claves.includes(clave));
}

function payloadPortalValido(type: string, payload: unknown): boolean {
  if (!esRegistro(payload)) return false;
  switch (type) {
    case 'hello': {
      const requiere = payload['requiere'];
      return clavesPermitidas(payload, ['portalBuild', 'requiere']) &&
        typeof payload['portalBuild'] === 'string' && payload['portalBuild'].length <= 120 &&
        esRegistro(requiere) && clavesPermitidas(requiere, ['major', 'minMinor']) &&
        Number.isInteger(requiere['major']) && Number.isInteger(requiere['minMinor']) &&
        Number(requiere['major']) >= 0 && Number(requiere['minMinor']) >= 0;
    }
    // Una sola rama para los dos escaneos: los payloads son identicos y
    // duplicar la validacion es como se desincronizan los limites.
    case 'nfc.scan.start':
    case 'qr.scan.start':
      return clavesPermitidas(payload, ['timeoutMs', 'titulo']) &&
        Number.isInteger(payload['timeoutMs']) && Number(payload['timeoutMs']) >= 1_000 &&
        Number(payload['timeoutMs']) <= 120_000 &&
        (payload['titulo'] === undefined ||
          (typeof payload['titulo'] === 'string' && payload['titulo'].length <= 120));
    case 'nfc.scan.cancel':
    case 'qr.scan.cancel':
    case 'offline.route.clear':
    case 'sync.queue.flush':
    case 'connectivity.query':
    case 'track.stop':
      return Object.keys(payload).length === 0;
    // Traza en vivo (#280). SIN esta rama, `track.start` caia al `default:
    // return false` y se descartaba en silencio ANTES de llegar al shell:
    // el tipo estaba en TIPOS_PORTAL pero el validador de payload no lo
    // conocia. El emisor entero quedaba muerto y no habia error que lo
    // delatara. Agregar un tipo al protocolo son DOS ediciones, no una.
    case 'track.start':
      return clavesPermitidas(payload, ['intervalSeconds', 'patrolId', 'apiBaseUrl']) &&
        (payload['patrolId'] === undefined || typeof payload['patrolId'] === 'string') &&
        (payload['apiBaseUrl'] === undefined || typeof payload['apiBaseUrl'] === 'string') &&
        Number.isInteger(payload['intervalSeconds']) &&
        Number(payload['intervalSeconds']) >= 1 &&
        Number(payload['intervalSeconds']) <= 3_600;
    case 'permission.request':
      return clavesPermitidas(payload, ['permiso', 'divulgacionMostrada']) &&
        PERMISOS.includes(payload['permiso'] as Permiso) &&
        typeof payload['divulgacionMostrada'] === 'boolean';
    case 'permission.query':
      return clavesPermitidas(payload, ['permiso']) &&
        PERMISOS.includes(payload['permiso'] as Permiso);
    case 'offline.route.save': {
      const checkpoints = payload['checkpoints'];
      return clavesPermitidas(payload, [
        'patrolId', 'status', 'siteName', 'routeName', 'scheduledStartAt', 'scheduledEndAt',
        'estimatedDurationMin', 'checkpoints',
      ]) && esIdentificador(payload['patrolId']) &&
        (payload['status'] === 'pendiente' || payload['status'] === 'en_curso') &&
        esTexto(payload['siteName'], 160) && esTexto(payload['routeName'], 160) &&
        esFecha(payload['scheduledStartAt']) && esFecha(payload['scheduledEndAt']) &&
        Number.isInteger(payload['estimatedDurationMin']) &&
        Number(payload['estimatedDurationMin']) >= 1 && Number(payload['estimatedDurationMin']) <= 1_440 &&
        Array.isArray(checkpoints) && checkpoints.length > 0 && checkpoints.length <= 500 &&
        checkpoints.every((punto) => esRegistro(punto) &&
          clavesPermitidas(punto, ['id', 'name', 'position', 'isClosingPoint', 'tagUids']) &&
          esIdentificador(punto['id']) && esTexto(punto['name'], 160) &&
          Number.isInteger(punto['position']) && Number(punto['position']) >= 1 &&
          (punto['isClosingPoint'] === undefined || typeof punto['isClosingPoint'] === 'boolean') &&
          Array.isArray(punto['tagUids']) && punto['tagUids'].length <= 10 &&
          punto['tagUids'].every((uid) =>
            typeof uid === 'string' && uid.length >= 4 && uid.length <= 64 && /^[\x20-\x7E]+$/.test(uid)));
    }
    case 'sync.queue.enqueue': {
      const operacion = payload['operation'];
      if (!clavesPermitidas(payload, ['apiUrl', 'portalOrigin', 'operation']) ||
          typeof payload['apiUrl'] !== 'string' || !esApiUrl(payload['apiUrl']) ||
          typeof payload['portalOrigin'] !== 'string' || !esPortalOrigin(payload['portalOrigin']) ||
          !esRegistro(operacion) ||
          !clavesPermitidas(operacion, ['type', 'clientId', 'patrolId', 'payload', 'queuedAt'])) {
        return false;
      }
      return (operacion['type'] === 'scan' || operacion['type'] === 'event') &&
        esUuid(operacion['clientId']) &&
        (operacion['patrolId'] === undefined || esUuid(operacion['patrolId'])) &&
        (operacion['type'] !== 'scan' || esUuid(operacion['patrolId'])) &&
        esRegistro(operacion['payload']) && esFecha(operacion['queuedAt']);
    }
    case 'device.signature.register':
      return clavesPermitidas(payload, ['apiUrl', 'portalOrigin']) &&
        typeof payload['apiUrl'] === 'string' && esApiUrl(payload['apiUrl']) &&
        typeof payload['portalOrigin'] === 'string' && esPortalOrigin(payload['portalOrigin']);
    default:
      return false;
  }
}

const PERMISOS: readonly Permiso[] = [
  'nfc', 'camara', 'ubicacion', 'ubicacion-segundo-plano', 'notificaciones',
];

function payloadShellValido(type: string, payload: unknown): boolean {
  if (!esRegistro(payload)) return false;
  switch (type) {
    case 'ready':
      return esRegistro(payload['protocolo']) && esRegistro(payload['app']) &&
        esRegistro(payload['dispositivo']) && Array.isArray(payload['majorsSoportados']);
    case 'incompatible':
      return (payload['motivo'] === 'app-antigua' || payload['motivo'] === 'portal-antiguo') &&
        typeof payload['mensaje'] === 'string';
    case 'nfc.scan.result':
      return typeof payload['uid'] === 'string' && /^[0-9A-F]{4,64}$/.test(payload['uid']) &&
        payload['tech'] === 'nfc' && restoDelEscaneoValido(payload);
    case 'qr.scan.result':
      return typeof payload['uid'] === 'string' && esCodigoQrDePunto(payload['uid']) &&
        payload['tech'] === 'qr' && restoDelEscaneoValido(payload);
    case 'nfc.scan.error':
    case 'qr.scan.error':
      return CODIGOS_ESCANEO.includes(payload['codigo'] as CodigoErrorEscaneo) &&
        typeof payload['mensaje'] === 'string' && typeof payload['reintentable'] === 'boolean';
    case 'permission.result':
      return PERMISOS.includes(payload['permiso'] as Permiso) &&
        ESTADOS_PERMISO.includes(payload['estado'] as EstadoPermiso) &&
        typeof payload['puedeVolverAPedir'] === 'boolean';
    case 'offline.route.saved':
      return esIdentificador(payload['patrolId']) && esFecha(payload['savedAt']);
    case 'offline.route.cleared':
      return Object.keys(payload).length === 0;
    case 'sync.queue.enqueued':
      return esUuid(payload['clientId']) && typeof payload['inserted'] === 'boolean';
    case 'sync.queue.flushed':
      return Number.isInteger(payload['processed']) && Number(payload['processed']) >= 0 &&
        Number.isInteger(payload['pending']) && Number(payload['pending']) >= 0;
    case 'device.signature.registered':
      return esUuid(payload['deviceId']);
    case 'connectivity.state':
      return typeof payload['enLinea'] === 'boolean' &&
        TIPOS_CONEXION.includes(payload['tipo'] as TipoConexion);
    case 'error':
      return CODIGOS_PUENTE.includes(payload['codigo'] as CodigoErrorPuente) &&
        typeof payload['mensaje'] === 'string';
    // Traza en vivo (#280), sentido app -> portal. SIN esta rama, `track.point`
    // caia al `default: return false` y CADA posicion de la traza se descartaba
    // en silencio: el mensaje estaba declarado en TIPOS_SHELL, el emisor nativo
    // lo mandaba, y el portal lo tiraba sin dejar rastro ni en consola. Es el
    // mismo defecto que ya habia tenido `track.start` en el sentido contrario;
    // un tipo declarado sin su caso aca no falla ruidosamente, desaparece.
    case 'track.point':
      return esFecha(payload['recordedAt']) &&
        esLatitud(payload['latitude']) &&
        esLongitud(payload['longitude']) &&
        (payload['accuracyM'] === undefined ||
          (typeof payload['accuracyM'] === 'number' &&
            Number.isFinite(payload['accuracyM']) &&
            payload['accuracyM'] >= 0));
    default:
      return false;
  }
}

/**
 * Las coordenadas se validan por rango y no solo por tipo: un GPS que devuelve
 * 0/0 o un NaN serializado como null no puede entrar a la traza como si fuera
 * una posicion real del guardia.
 */
function esLatitud(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= -90 && valor <= 90;
}

function esLongitud(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= -180 && valor <= 180;
}

/**
 * Lo que comparten `nfc.scan.result` y `qr.scan.result`: hora, posicion opcional
 * y la terna de firma del dispositivo, que va COMPLETA o no va —media firma no
 * se puede verificar y es peor que ninguna, porque parece evidencia.
 *
 * Lo unico que cambia entre los dos mensajes es la forma del identificador
 * leido, y eso lo valida cada rama con su propio patron.
 */
function restoDelEscaneoValido(payload: Record<string, unknown>): boolean {
  return typeof payload['scannedAt'] === 'string' &&
    !Number.isNaN(Date.parse(payload['scannedAt'])) &&
    ((payload['clientScanId'] === undefined && payload['deviceId'] === undefined &&
      payload['signature'] === undefined) ||
     (esUuid(payload['clientScanId']) && esUuid(payload['deviceId']) &&
      typeof payload['signature'] === 'string' && /^[0-9a-f]{64}$/.test(payload['signature']))) &&
    (payload['latitude'] === undefined ||
      (typeof payload['latitude'] === 'number' && payload['latitude'] >= -90 && payload['latitude'] <= 90)) &&
    (payload['longitude'] === undefined ||
      (typeof payload['longitude'] === 'number' && payload['longitude'] >= -180 && payload['longitude'] <= 180)) &&
    (payload['accuracyM'] === undefined ||
      (typeof payload['accuracyM'] === 'number' && payload['accuracyM'] >= 0));
}

function esTexto(valor: unknown, maximo: number): valor is string {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= maximo;
}

function esIdentificador(valor: unknown): valor is string {
  return esTexto(valor, 128) && /^[A-Za-z0-9_-]+$/.test(valor);
}

function esFecha(valor: unknown): valor is string {
  return typeof valor === 'string' && !Number.isNaN(Date.parse(valor));
}

function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor);
}

function esApiUrl(valor: string): boolean {
  if (valor.length > 500) return false;
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname));
  } catch {
    return false;
  }
}

function esPortalOrigin(valor: string): boolean {
  if (!esApiUrl(valor)) return false;
  try {
    return new URL(valor).origin === valor;
  } catch {
    return false;
  }
}

const CODIGOS_ESCANEO: readonly CodigoErrorEscaneo[] = [
  'nfc-no-disponible', 'nfc-desactivado', 'permiso-denegado', 'cancelado',
  'timeout', 'etiqueta-ilegible', 'error-desconocido',
  'camara-no-disponible', 'camara-ocupada', 'codigo-ilegible',
];
const ESTADOS_PERMISO: readonly EstadoPermiso[] = [
  'concedido', 'denegado', 'denegado-definitivo', 'no-aplica',
];
const TIPOS_CONEXION: readonly TipoConexion[] = ['wifi', 'celular', 'ninguna', 'desconocida'];
const CODIGOS_PUENTE: readonly CodigoErrorPuente[] = [
  'mensaje-invalido', 'mensaje-demasiado-grande', 'origen-no-autorizado',
  'tipo-desconocido', 'divulgacion-faltante', 'error-interno',
];

/**
 * Lee un mensaje crudo. Valida forma, tamaño y que el tipo pertenezca al
 * catalogo de la direccion esperada.
 *
 * NO valida el contenido del payload campo por campo: eso lo hace quien lo
 * consume, que es el unico que sabe que espera. Lo que si se garantiza aca es
 * que nada de esto se evalua como codigo — el mensaje se parsea con `JSON.parse`
 * y jamas con `eval`.
 */
function leer<T extends { type: string }>(
  crudo: string,
  tiposValidos: readonly string[],
  validarPayload: (type: string, payload: unknown) => boolean,
): ResultadoLectura<T> {
  if (crudo.length * 2 > MAX_BYTES_MENSAJE) {
    return { ok: false, codigo: 'mensaje-demasiado-grande', detalle: `${crudo.length} caracteres` };
  }

  let plano: unknown;
  try {
    plano = JSON.parse(crudo);
  } catch {
    return { ok: false, codigo: 'mensaje-invalido', detalle: 'JSON ilegible' };
  }

  if (!esSobre(plano)) {
    return { ok: false, codigo: 'mensaje-invalido', detalle: 'sobre incompleto' };
  }
  if (!tiposValidos.includes(plano.type)) {
    return { ok: false, codigo: 'tipo-desconocido', detalle: plano.type };
  }
  if (!validarPayload(plano.type, plano.payload)) {
    return { ok: false, codigo: 'mensaje-invalido', detalle: `payload ${plano.type}` };
  }

  return { ok: true, mensaje: plano as unknown as T };
}

export function leerMensajePortal(crudo: string): ResultadoLectura<MensajePortal> {
  return leer<MensajePortal>(crudo, TIPOS_PORTAL, payloadPortalValido);
}

export function leerMensajeShell(crudo: string): ResultadoLectura<MensajeShell> {
  return leer<MensajeShell>(crudo, TIPOS_SHELL, payloadShellValido);
}

/** Contador local; no pretende ser unico entre dispositivos, solo dentro de la sesion. */
let contador = 0;

export function nuevoId(prefijo: string): string {
  contador += 1;
  return `${prefijo}-${Date.now().toString(36)}-${contador.toString(36)}`;
}

export function armarSobre<T extends string, P>(
  type: T,
  payload: P,
  opciones?: { readonly replyTo?: string; readonly prefijo?: string },
): Sobre<T, P> {
  const base = {
    p: PUENTE,
    v: PROTOCOLO_MAJOR,
    id: nuevoId(opciones?.prefijo ?? 'msg'),
    type,
    payload,
    ts: new Date().toISOString(),
  } as const;
  return opciones?.replyTo === undefined ? base : { ...base, replyTo: opciones.replyTo };
}

/**
 * Convierte un mensaje en un literal de string de JavaScript seguro para
 * inyectar con `injectJavaScript`.
 *
 * El doble `JSON.stringify` no es un descuido: el primero produce el mensaje, el
 * segundo lo envuelve como literal escapado. U+2028 y U+2029 se escapan a mano
 * porque son validos dentro de JSON pero rompen el parser de JavaScript en
 * motores viejos, y basta un UID raro para caerse.
 */
export function comoLiteralJs(mensaje: MensajeShell): string {
  const SEP_LINEA = String.fromCharCode(0x2028);
  const SEP_PARRAFO = String.fromCharCode(0x2029);
  return JSON.stringify(JSON.stringify(mensaje))
    .split(SEP_LINEA)
    .join('\\u2028')
    .split(SEP_PARRAFO)
    .join('\\u2029');
}
