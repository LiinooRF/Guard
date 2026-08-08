'use client';

import { escribirJson, leerJson } from './guard-storage';
import { ensureFreshSession } from './use-session-refresh';
import { reflejarEnColaNativa } from './guard-native-outbox';

/**
 * La única puerta a la API desde la pantalla del guardia (#91, #92, #94).
 *
 * Todo lo que el guardia hace pasa por acá, y por acá pasa una sola regla: lo
 * que no se pudo mandar NO se pierde ni se olvida, queda en la cola y se
 * reintenta. Las rondas ocurren en subterráneos y perímetros sin señal, así que
 * "falló la red" es una condición de trabajo normal, no un error.
 *
 * Cómo se decide entre mandar y encolar:
 *
 *   navigator.onLine === false   -> se encola sin intentar (el intento colgaría
 *                                   el botón 30 segundos por nada).
 *   la red falla (TypeError)     -> se encola: reintentar sirve.
 *   el servidor responde 4xx     -> NO se encola: reintentar da el mismo error y
 *                                   el guardia tiene que enterarse ahora.
 *
 * La cola se envía por `POST /sync/push`, que aplica cada operación aislada y
 * devuelve un veredicto por operación: un escaneo inválido no bota a los otros
 * 39. La idempotencia es del dispositivo (`clientScanId` / `clientEventId`), así
 * que reenviar la cola completa es seguro.
 */

const CLAVE_COLA = 'voxia.guard.outbox.v1';
const ESPERA_BASE_MS = 2_000;
const ESPERA_MAX_MS = 60_000;

export type TipoOperacion = 'scan' | 'event';

export interface OperacionEnCola {
  clientId: string;
  type: TipoOperacion;
  patrolId?: string;
  payload: Record<string, unknown>;
  /** Hora del teléfono al encolar. Contra la del servidor da el tiempo sin señal. */
  queuedAt: string;
  intentos: number;
  estado: 'pendiente' | 'rechazada';
  motivo?: string;
}

export interface VeredictoSync {
  clientId: string;
  status: 'aplicado' | 'duplicado' | 'rechazado';
  reason?: string;
  serverId?: string;
}

export interface EstadoCola {
  pendientes: number;
  rechazadas: OperacionEnCola[];
  sincronizando: boolean;
  ultimoEnvioAt?: string;
  /** Motivo técnico del último fallo de envío. No se muestra crudo al guardia. */
  ultimoFallo?: string;
}

export type PayloadEscaneo = {
  uid: string;
  method: 'nfc' | 'qr';
  clientScanId: string;
  scannedAt?: string;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  deviceId?: string;
  signature?: string;
};

export type Criticidad = 'info' | 'baja' | 'media' | 'alta' | 'panico';

export type PayloadNovedad = {
  criticality: Criticidad;
  clientEventId: string;
  text?: string;
  patrolId?: string;
  reportedAt?: string;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
};

export interface RespuestaEscaneo {
  replay: boolean;
  /**
   * El punto ya tenía OTRO escaneo en esta ronda (no es el replay: ese es el
   * mismo escaneo reenviado). El registro nuevo se conserva; esto existe para
   * que la pantalla se lo DIGA al guardia, que antes repetía sin saber si el
   * primero contó.
   */
  alreadyScanned?: boolean;
  /** Hora del primer escaneo de ese punto, que es la que vale para el informe. */
  firstScannedAt?: string | null;
  alertSent: boolean;
  /** Id del escaneo en el servidor: es donde se cuelga la foto del punto. */
  scanId?: string | null;
  checkpoint: {
    id: string;
    name: string;
    kind: string;
    /**
     * Veredicto del servidor con el horario del recinto en ESTE instante. Manda
     * sobre la política que vino en `GET /guard/home`, que es una foto fija que
     * una ronda larga puede dejar vieja. `null`/ausente = no lo pudo resolver y
     * decide el teléfono.
     */
    photoRequired?: boolean | null;
  };
  anomalies: string[];
  progress: { scanned: number; expected: number; pct: number; missedCheckpointIds: string[] };
  patrol: { id: string; status: string; compliancePct: number | null };
}

export interface RespuestaNovedad {
  id?: string;
  replay: boolean;
  criticality: Criticidad;
  /** `false` = quedó registrada pero no había a quién avisar. Se dice tal cual. */
  notified: boolean;
}

export type Envio<T> =
  | { clase: 'confirmado'; respuesta: T }
  | { clase: 'encolado' }
  | { clase: 'rechazado'; mensaje: string };

// --------------------------------------------------------------- estado local

let cola: OperacionEnCola[] | null = null;
let sincronizando = false;
let ultimoEnvioAt: string | undefined;
let ultimoFallo: string | undefined;
let fallos = 0;
let temporizador: number | null = null;
let autoSyncActivo = false;

const oyentesCola = new Set<(estado: EstadoCola) => void>();
const oyentesVeredicto = new Set<(veredictos: readonly VeredictoSync[]) => void>();

function cargar(): OperacionEnCola[] {
  cola ??= leerJson<OperacionEnCola[]>(CLAVE_COLA, []);
  return cola;
}

function guardar(siguiente: OperacionEnCola[]): void {
  cola = siguiente;
  escribirJson(CLAVE_COLA, siguiente);
  notificar();
}

export function estadoCola(): EstadoCola {
  const actual = cargar();
  return {
    pendientes: actual.filter((operacion) => operacion.estado === 'pendiente').length,
    rechazadas: actual.filter((operacion) => operacion.estado === 'rechazada'),
    sincronizando,
    ...(ultimoEnvioAt ? { ultimoEnvioAt } : {}),
    ...(ultimoFallo ? { ultimoFallo } : {}),
  };
}

function notificar(): void {
  const estado = estadoCola();
  for (const oyente of oyentesCola) oyente(estado);
}

/** Avisa de inmediato con el estado actual y devuelve la baja. */
export function suscribirCola(fn: (estado: EstadoCola) => void): () => void {
  oyentesCola.add(fn);
  fn(estadoCola());
  return () => {
    oyentesCola.delete(fn);
  };
}

/** Veredicto por operación de cada `POST /sync/push`, para reconciliar la ronda. */
export function suscribirVeredictos(fn: (veredictos: readonly VeredictoSync[]) => void): () => void {
  oyentesVeredicto.add(fn);
  return () => {
    oyentesVeredicto.delete(fn);
  };
}

export function encolar(operacion: {
  clientId: string;
  type: TipoOperacion;
  patrolId?: string;
  payload: Record<string, unknown>;
}, apiUrl = urlApi): void {
  const queuedAt = new Date().toISOString();
  guardar([
    ...cargar(),
    { ...operacion, queuedAt, intentos: 0, estado: 'pendiente' },
  ]);
  void reflejarEnColaNativa(apiUrl, { ...operacion, queuedAt }).catch(() => undefined);
  programar(ESPERA_BASE_MS);
}

/** Quita los avisos de operaciones rechazadas una vez que el guardia los leyó. */
export function descartarRechazadas(): void {
  guardar(cargar().filter((operacion) => operacion.estado !== 'rechazada'));
}

// ------------------------------------------------------------------ sincronía

/** La URL se fija al arrancar el auto-envío; los reintentos por timer la reusan. */
let urlApi = '/api';

function programar(ms: number): void {
  if (typeof window === 'undefined' || temporizador !== null) return;
  temporizador = window.setTimeout(() => {
    temporizador = null;
    void sincronizar(urlApi);
  }, ms);
}

function espera(): number {
  return Math.min(ESPERA_BASE_MS * 2 ** Math.max(fallos - 1, 0), ESPERA_MAX_MS);
}

/**
 * Reintento automático: al recuperar la red y al volver la pantalla al frente.
 * Un WebView en segundo plano no ejecuta timers, así que `visibilitychange` es
 * el disparador que de verdad funciona cuando el guardia vuelve a mirar.
 */
export function iniciarAutoSync(apiUrl: string): () => void {
  urlApi = apiUrl;
  if (typeof window === 'undefined' || autoSyncActivo) return () => undefined;
  autoSyncActivo = true;

  const alVolverLaRed = () => {
    fallos = 0;
    void sincronizar(apiUrl);
  };
  const alVolverAlFrente = () => {
    if (document.visibilityState === 'visible') void sincronizar(apiUrl);
  };

  window.addEventListener('online', alVolverLaRed);
  document.addEventListener('visibilitychange', alVolverAlFrente);
  void sincronizar(apiUrl);

  return () => {
    autoSyncActivo = false;
    window.removeEventListener('online', alVolverLaRed);
    document.removeEventListener('visibilitychange', alVolverAlFrente);
  };
}

export async function sincronizar(apiUrl: string): Promise<void> {
  if (sincronizando) return;
  const pendientes = cargar().filter((operacion) => operacion.estado === 'pendiente');
  if (!pendientes.length) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  sincronizando = true;
  ultimoFallo = undefined;
  notificar();
  try {
    const veredictos = await empujar(apiUrl, pendientes);
    aplicarVeredictos(veredictos);
    fallos = 0;
    ultimoEnvioAt = new Date().toISOString();
    for (const oyente of oyentesVeredicto) oyente(veredictos);
  } catch (causa) {
    fallos += 1;
    ultimoFallo = causa instanceof Error ? causa.message : 'fallo_desconocido';
    programar(espera());
  } finally {
    sincronizando = false;
    notificar();
  }
}

async function empujar(
  apiUrl: string,
  operaciones: readonly OperacionEnCola[],
): Promise<VeredictoSync[]> {
  const respuesta = await pedirApi(apiUrl, '/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operations: operaciones.map((operacion) => ({
        type: operacion.type,
        clientId: operacion.clientId,
        ...(operacion.patrolId ? { patrolId: operacion.patrolId } : {}),
        payload: operacion.payload,
        queuedAt: operacion.queuedAt,
      })),
    }),
  });

  // 413: el lote supera el máximo de la empresa (`syncMaxBatchSize`, que es una
  // regla del tenant). El tamaño no se cablea acá: se parte a la mitad hasta que
  // entre, y así sirve para cualquier valor que configure el admin.
  if (respuesta.status === 413 && operaciones.length > 1) {
    const mitad = Math.ceil(operaciones.length / 2);
    const primera = await empujar(apiUrl, operaciones.slice(0, mitad));
    const segunda = await empujar(apiUrl, operaciones.slice(mitad));
    return [...primera, ...segunda];
  }
  if (!respuesta.ok) throw new Error(`sync_${respuesta.status}`);

  const cuerpo = (await respuesta.json()) as { results?: VeredictoSync[] };
  return cuerpo.results ?? [];
}

function aplicarVeredictos(veredictos: readonly VeredictoSync[]): void {
  const porId = new Map(veredictos.map((veredicto) => [veredicto.clientId, veredicto]));
  const siguiente: OperacionEnCola[] = [];

  for (const operacion of cargar()) {
    const veredicto = porId.get(operacion.clientId);
    if (!veredicto) {
      siguiente.push(operacion);
      continue;
    }
    // 'aplicado' y 'duplicado' son el mismo desenlace para el teléfono: el
    // trabajo está en el servidor y la operación sale de la cola.
    if (veredicto.status === 'rechazado') {
      siguiente.push({
        ...operacion,
        estado: 'rechazada',
        intentos: operacion.intentos + 1,
        ...(veredicto.reason ? { motivo: veredicto.reason } : {}),
      });
    }
  }
  guardar(siguiente);
}

// -------------------------------------------------------------- envío directo

/**
 * Llamada a la API con la sesión fresca. `voxia_access` dura 15 minutos y una
 * ronda dura más: sin renovar antes, el escaneo del punto 5 se cae con 401.
 */
export async function pedirApi(
  apiUrl: string,
  ruta: string,
  init: RequestInit = {},
): Promise<Response> {
  await ensureFreshSession(apiUrl);
  return fetch(`${apiUrl}${ruta}`, { ...init, credentials: 'include', cache: 'no-store' });
}

async function mensajeDeError(respuesta: Response, porDefecto: string): Promise<string> {
  const cuerpo = (await respuesta.json().catch(() => null)) as { message?: string } | null;
  return cuerpo?.message ?? porDefecto;
}

function sinRed(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}

export async function enviarEscaneo(
  apiUrl: string,
  patrolId: string,
  payload: PayloadEscaneo,
): Promise<Envio<RespuestaEscaneo>> {
  const encolarEste = () => {
    encolar({ clientId: payload.clientScanId, type: 'scan', patrolId, payload }, apiUrl);
    return { clase: 'encolado' as const };
  };
  if (sinRed()) return encolarEste();

  let respuesta: Response;
  try {
    respuesta = await pedirApi(apiUrl, `/guard/patrols/${patrolId}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return encolarEste();
  }

  if (respuesta.ok) {
    return { clase: 'confirmado', respuesta: (await respuesta.json()) as RespuestaEscaneo };
  }
  // 5xx es del servidor y puede pasar solo: se encola igual que un corte de red.
  if (respuesta.status >= 500) return encolarEste();
  return {
    clase: 'rechazado',
    mensaje: await mensajeDeError(respuesta, 'No pudimos registrar el punto.'),
  };
}

export async function enviarNovedad(
  apiUrl: string,
  payload: PayloadNovedad,
): Promise<Envio<RespuestaNovedad>> {
  const encolarEsta = () => {
    encolar({
      clientId: payload.clientEventId,
      type: 'event',
      ...(payload.patrolId ? { patrolId: payload.patrolId } : {}),
      payload,
    }, apiUrl);
    return { clase: 'encolado' as const };
  };
  if (sinRed()) return encolarEsta();

  let respuesta: Response;
  try {
    respuesta = await pedirApi(apiUrl, '/guard/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return encolarEsta();
  }

  if (respuesta.ok) {
    return { clase: 'confirmado', respuesta: (await respuesta.json()) as RespuestaNovedad };
  }
  if (respuesta.status >= 500) return encolarEsta();
  return {
    clase: 'rechazado',
    mensaje: await mensajeDeError(respuesta, 'No pudimos registrar la novedad.'),
  };
}

/**
 * Foto de una novedad.
 *
 * Va en una petición aparte del reporte y no en el mismo POST: el texto pesa
 * bytes y la foto pesa megas, así que en terreno una subida cortada se llevaría
 * también el reporte, que es la parte que importa. Por eso la foto se manda
 * recién cuando el servidor devolvió el id de la novedad, y si esta segunda
 * parte falla la pantalla lo dice en vez de fingir que subió.
 */
export async function subirFotoNovedad(
  apiUrl: string,
  eventId: string,
  foto: File,
  takenAtDevice: string,
): Promise<boolean> {
  return subirFoto(apiUrl, `/evidence/events/${eventId}/photos`, foto, takenAtDevice);
}

/**
 * Foto de un PUNTO de la ronda: la del estado de la puerta en los accesos
 * críticos, que es el requisito del producto.
 *
 * Cuelga del escaneo y no de la ronda, así que necesita el id que devuelve el
 * servidor: `scanId` cuando el escaneo se mandó en línea, y el `serverId` del
 * veredicto de `POST /sync/push` cuando viajó en la cola. Antes de tener ese id
 * la foto espera en el almacén persistente, igual que la de una novedad.
 */
export async function subirFotoPunto(
  apiUrl: string,
  scanId: string,
  foto: File,
  takenAtDevice: string,
): Promise<boolean> {
  return subirFoto(apiUrl, `/evidence/scans/${scanId}/photos`, foto, takenAtDevice);
}

async function subirFoto(
  apiUrl: string,
  ruta: string,
  foto: File,
  takenAtDevice: string,
): Promise<boolean> {
  const cuerpo = new FormData();
  cuerpo.append('foto', foto);
  // La hora de CAPTURA, que llega desde quien llama. Poner `new Date()` aca
  // registraba la hora en que hubo señal: una ronda de las 03:00 sincronizada a
  // las 07:00 quedaba con las 07:00, y eso invalida la evidencia.
  cuerpo.append('takenAtDevice', takenAtDevice);
  try {
    const respuesta = await pedirApi(apiUrl, ruta, { method: 'POST', body: cuerpo });
    return respuesta.ok;
  } catch {
    return false;
  }
}

export async function marcarSalidaDeJornada(
  apiUrl: string,
): Promise<{ ok: boolean; mensaje: string }> {
  let respuesta: Response;
  try {
    respuesta = await pedirApi(apiUrl, '/guard/shift/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    return { ok: false, mensaje: 'Sin señal: intenta marcar la salida cuando tengas conexión.' };
  }

  if (respuesta.ok) return { ok: true, mensaje: 'Salida marcada.' };
  // 409 es "no tenías jornada abierta": no es un fallo que el guardia deba
  // resolver, así que no se muestra como error.
  if (respuesta.status === 409) return { ok: true, mensaje: 'Tu jornada ya estaba cerrada.' };
  return { ok: false, mensaje: await mensajeDeError(respuesta, 'No pudimos marcar la salida.') };
}
