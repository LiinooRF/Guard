'use client';

import {
  enviarNovedad,
  sincronizar,
  suscribirVeredictos,
  type PayloadNovedad,
} from './guard-outbox';
import { escribirJson, leerJson, nuevoUuid } from './guard-storage';

/**
 * Entrega garantizada del boton de panico (#125).
 *
 * El panico NO es otro modelo: es una novedad con criticidad maxima, y se manda
 * por el mismo camino que las demas (`enviarNovedad` -> cola de `guard-outbox`).
 * Lo que agrega este archivo es lo unico que el panico necesita distinto:
 *
 *   1. Un registro propio en el telefono que se escribe ANTES de intentar la
 *      red. Si la app muere entre el toque y el envio, al volver a abrirla la
 *      alerta sigue ahi y se reintenta. La cola comun tambien persiste, pero
 *      recien despues de que el envio directo fallo: esa ventana existe y para
 *      una alerta de panico no es aceptable.
 *   2. Insistencia con cadencia propia. La cola comun espacia sus reintentos
 *      hasta 60 s; mientras haya un panico sin entregar se fuerza un envio cada
 *      `panicRetrySeconds` (regla del tenant) y al volver la senal.
 *   3. Estado visible por alerta: encolado -> entregado -> recibido por X.
 *
 * MODO SILENCIOSO: este archivo no reproduce sonido, no vibra y no muestra
 * nada. Ningun camino llama a `navigator.vibrate` ni a `Audio`. Si el guardia
 * esta frente a un asaltante, una alarma que suena lo pone en riesgo; esa es la
 * diferencia entre una funcion util y una peligrosa.
 *
 * NADA DE DATOS DE PERSONAS: no se escribe una sola linea de log aca. Ni
 * coordenadas, ni identificadores del guardia, ni el nombre de quien acusa
 * recibo.
 */

const CLAVE_PANICOS = 'voxia.guard.panic.v1';

/** Cuantas alertas terminadas se conservan para consulta. Las no entregadas NUNCA se podan. */
const MAX_GUARDADAS = 20;

/**
 * Piso tecnico de la insistencia, no una regla de negocio: evita que una
 * configuracion en 0 convierta el reintento en un bucle sobre la API. El valor
 * real lo pone `panicRetrySeconds` (ver panico-reglas.tsx).
 */
const SEGUNDOS_PISO_INSISTENCIA = 5;

/** Cadencia del sondeo de acuse de recibo. Solo corre si hay algo entregado sin acusar. */
const ESPERA_ACUSE_MS = 20_000;

/** Cuanto se sigue preguntando por el acuse de una alerta ya entregada. */
const VENTANA_ACUSE_MS = 60 * 60 * 1000;

export type EstadoEntrega = 'encolado' | 'entregado' | 'acusado' | 'rechazado';

const ESTADOS: readonly EstadoEntrega[] = ['encolado', 'entregado', 'acusado', 'rechazado'];

export interface Ubicacion {
  latitude: number;
  longitude: number;
  accuracyM?: number;
}

export interface AlertaPanico {
  /** Clave de idempotencia del dispositivo. Reenviar la misma no duplica el evento. */
  clientEventId: string;
  /** Hora del telefono al soltar el boton, ISO-8601. */
  disparadaAt: string;
  estado: EstadoEntrega;
  /** Envios directos intentados. Los reintentos de la cola comun no se cuentan aca. */
  intentos: number;
  /**
   * Ronda a la que pertenece. Se guarda para poder reenviarla igual despues de
   * que la app se cierre; las coordenadas NO se guardan (dato de la persona) y
   * en ese camino se pierden.
   */
  patrolId?: string;
  /** Id del servidor. Existe recien cuando el servidor confirmo el evento. */
  eventId?: string;
  /**
   * `true` = habia a quien avisar y se aviso. `false` = quedo registrada y no
   * habia a quien avisar, que es informacion critica para el guardia.
   * `undefined` = no lo sabemos (llego por la cola, o fue un reenvio idempotente
   * y el servidor ya no vuelve a avisar). No se inventa.
   */
  avisado?: boolean;
  /** Etiqueta de quien se hizo cargo. Nunca un identificador ni un contacto. */
  acusadaPor?: string;
  acusadaAt?: string;
  /**
   * El guardia la corrigio como falsa alarma. La alerta NO se borra —el libro es
   * append-only— y esto solo evita ofrecer dos veces la misma correccion.
   */
  falsaAlarma?: boolean;
  /** Por que el servidor la rechazo. Se muestra tal cual al guardia. */
  motivo?: string;
}

/**
 * Lee si alguien acuso recibo de la alerta.
 *
 * Se inyecta en vez de llamarse aca porque HOY NO EXISTE el endpoint: la API
 * tiene el acuse (`POST /escalation/notifications/:id/acknowledge`) pero no una
 * lectura que el guardia pueda hacer sobre SU evento. Ver INTEGRACION.md: sin
 * esto el estado se queda en "entregada", que es verdad, en vez de mostrar un
 * "recibido por X" que nadie confirmo.
 */
export type LectorAcuse = (
  eventId: string,
) => Promise<{ porQuien?: string; enAt?: string } | undefined>;

// ------------------------------------------------------------------- estado

let alertas: AlertaPanico[] | null = null;
let urlApi = '/api';
let segundosInsistencia = 0;
let lectorAcuse: LectorAcuse | undefined;
let activo = false;
let temporizadorInsistencia: number | null = null;
let temporizadorAcuse: number | null = null;
let bajaVeredictos: (() => void) | null = null;

const oyentes = new Set<(alertas: readonly AlertaPanico[]) => void>();

function cargar(): AlertaPanico[] {
  alertas ??= sanear(leerJson<unknown>(CLAVE_PANICOS, []));
  return alertas;
}

function guardar(siguiente: AlertaPanico[]): void {
  const podada = podar(siguiente);
  alertas = podada;
  escribirJson(CLAVE_PANICOS, podada);
  for (const oyente of oyentes) oyente(podada);
}

/**
 * Lo que hay en el disco es de otra version del portal o esta corrupto hasta que
 * se demuestre lo contrario. Una alerta con forma rara se descarta; nunca se
 * deja caer la pantalla del guardia por eso.
 */
function sanear(valor: unknown): AlertaPanico[] {
  if (!Array.isArray(valor)) return [];
  const salida: AlertaPanico[] = [];
  for (const item of valor) {
    if (typeof item !== 'object' || item === null) continue;
    const campo = item as Record<string, unknown>;
    const id = campo['clientEventId'];
    const disparadaAt = campo['disparadaAt'];
    const estado = campo['estado'];
    if (typeof id !== 'string' || typeof disparadaAt !== 'string') continue;
    if (!ESTADOS.includes(estado as EstadoEntrega)) continue;
    salida.push({
      clientEventId: id,
      disparadaAt,
      estado: estado as EstadoEntrega,
      intentos: typeof campo['intentos'] === 'number' ? campo['intentos'] : 0,
      ...(typeof campo['patrolId'] === 'string' ? { patrolId: campo['patrolId'] } : {}),
      ...(typeof campo['eventId'] === 'string' ? { eventId: campo['eventId'] } : {}),
      ...(typeof campo['avisado'] === 'boolean' ? { avisado: campo['avisado'] } : {}),
      ...(typeof campo['acusadaPor'] === 'string' ? { acusadaPor: campo['acusadaPor'] } : {}),
      ...(typeof campo['acusadaAt'] === 'string' ? { acusadaAt: campo['acusadaAt'] } : {}),
      ...(campo['falsaAlarma'] === true ? { falsaAlarma: true } : {}),
      ...(typeof campo['motivo'] === 'string' ? { motivo: campo['motivo'] } : {}),
    });
  }
  return salida;
}

/** Conserva todas las que faltan por entregar y solo poda las ya resueltas. */
function podar(lista: readonly AlertaPanico[]): AlertaPanico[] {
  const sinEntregar = lista.filter((alerta) => alerta.estado === 'encolado').length;
  let cupo = Math.max(MAX_GUARDADAS - sinEntregar, 0);
  const salida: AlertaPanico[] = [];
  for (const alerta of lista) {
    if (alerta.estado === 'encolado') {
      salida.push(alerta);
      continue;
    }
    if (cupo > 0) {
      salida.push(alerta);
      cupo -= 1;
    }
  }
  return salida;
}

function actualizar(
  clientEventId: string,
  cambio: (alerta: AlertaPanico) => AlertaPanico,
): void {
  guardar(
    cargar().map((alerta) =>
      alerta.clientEventId === clientEventId ? cambio(alerta) : alerta,
    ),
  );
}

/** Avisa de inmediato con lo que hay y devuelve la baja, igual que `suscribirCola`. */
export function suscribirPanico(fn: (alertas: readonly AlertaPanico[]) => void): () => void {
  oyentes.add(fn);
  fn(cargar());
  return () => {
    oyentes.delete(fn);
  };
}

export function alertasPanico(): readonly AlertaPanico[] {
  return cargar();
}

export function haySinEntregar(): boolean {
  return cargar().some((alerta) => alerta.estado === 'encolado');
}

/** Saca de la lista una alerta ya resuelta. Una sin entregar no se puede borrar. */
export function archivarAlerta(clientEventId: string): void {
  guardar(
    cargar().filter(
      (alerta) => alerta.clientEventId !== clientEventId || alerta.estado === 'encolado',
    ),
  );
}

/**
 * Deja anotado que el guardia ya corrigio esta alerta como falsa alarma. La
 * correccion vive en el servidor (`POST /escalation/events/:id/false-alarm`);
 * esto es solo para no volver a ofrecerla.
 */
export function marcarFalsaAlarma(clientEventId: string): void {
  actualizar(clientEventId, (alerta) => ({ ...alerta, falsaAlarma: true }));
}

export function configurarLectorAcuse(fn: LectorAcuse | undefined): void {
  lectorAcuse = fn;
  programarAcuse();
}

// -------------------------------------------------------------------- envio

/**
 * Dispara una alerta de panico.
 *
 * NO es asincrona a proposito: devuelve apenas la alerta quedo escrita en el
 * telefono, y el envio sigue por su cuenta. Nadie espera a la red para saber si
 * el panico "salio" — eso lo dice despues la linea de estado. Una pantalla
 * bloqueada esperando un fetch delante de un asaltante no es una opcion.
 *
 * No lleva texto a proposito: quien aprieta ese boton no esta en condiciones de
 * escribir, y el servidor tampoco lo exige para `panico`.
 */
export function dispararPanico(opciones: {
  patrolId?: string;
  ubicacion?: Ubicacion;
}): AlertaPanico {
  const clientEventId = nuevoUuid();
  const disparadaAt = new Date().toISOString();
  const alerta: AlertaPanico = {
    clientEventId,
    disparadaAt,
    estado: 'encolado',
    intentos: 0,
    ...(opciones.patrolId ? { patrolId: opciones.patrolId } : {}),
  };

  guardar([alerta, ...cargar()]);

  void entregar({
    criticality: 'panico',
    clientEventId,
    reportedAt: disparadaAt,
    ...(opciones.patrolId ? { patrolId: opciones.patrolId } : {}),
    ...(opciones.ubicacion
      ? {
          latitude: opciones.ubicacion.latitude,
          longitude: opciones.ubicacion.longitude,
          ...(opciones.ubicacion.accuracyM === undefined
            ? {}
            : { accuracyM: opciones.ubicacion.accuracyM }),
        }
      : {}),
  });

  return alerta;
}

async function entregar(payload: PayloadNovedad): Promise<void> {
  actualizar(payload.clientEventId, (alerta) => ({
    ...alerta,
    intentos: alerta.intentos + 1,
  }));

  const envio = await enviarNovedad(urlApi, payload);

  if (envio.clase === 'rechazado') {
    // 4xx: reintentar da el mismo error. El guardia tiene que enterarse AHORA,
    // no cuando alguien revise el informe.
    actualizar(payload.clientEventId, (alerta) => ({
      ...alerta,
      estado: 'rechazado',
      motivo: envio.mensaje,
    }));
    return;
  }

  if (envio.clase === 'encolado') {
    // Quedo en la cola comun, que persiste y reintenta sola. Aca solo se le
    // pone encima la insistencia con cadencia de panico.
    programarInsistencia();
    return;
  }

  const respuesta = envio.respuesta;
  actualizar(payload.clientEventId, (alerta) => ({
    ...alerta,
    estado: 'entregado',
    ...(respuesta.id ? { eventId: respuesta.id } : {}),
    // En un reenvio idempotente el servidor NO vuelve a avisar, asi que
    // `notified` viene en false y no significa "no aviso a nadie". Se conserva
    // lo que ya sabiamos en vez de mentir.
    ...(respuesta.replay ? {} : { avisado: respuesta.notified }),
  }));
  programarAcuse();
}

/**
 * Fuerza un envio de la cola ahora. Es lo que hace el boton "Reintentar" y lo
 * que corre cada `panicRetrySeconds` mientras algo siga sin entregar.
 */
export function reintentarAhora(): void {
  void sincronizar(urlApi);
  programarInsistencia();
}

/**
 * Reenvia lo que quedo sin entregar de una sesion anterior.
 *
 * Cubre el hueco de la app cerrada entre el toque y el encolado. El reenvio es
 * idempotente por `clientEventId`, asi que en el peor caso el servidor responde
 * "ya la tenia". Si la operacion ya estaba en la cola comun puede quedar
 * duplicada ahi por un momento: `POST /sync/push` la resuelve como `duplicado` y
 * las dos salen de la cola. Duplicar un intento es barato; perder un panico no.
 */
async function recuperarPendientes(): Promise<void> {
  for (const alerta of cargar().filter((item) => item.estado === 'encolado')) {
    await entregar({
      criticality: 'panico',
      clientEventId: alerta.clientEventId,
      reportedAt: alerta.disparadaAt,
      ...(alerta.patrolId ? { patrolId: alerta.patrolId } : {}),
    });
  }
}

// -------------------------------------------------------------- insistencia

function programarInsistencia(): void {
  if (typeof window === 'undefined' || temporizadorInsistencia !== null) return;
  if (!haySinEntregar()) return;

  const espera = Math.max(segundosInsistencia, SEGUNDOS_PISO_INSISTENCIA) * 1000;
  temporizadorInsistencia = window.setTimeout(() => {
    temporizadorInsistencia = null;
    // `sincronizar` se corta solo si no hay senal o si ya hay un envio en curso.
    void sincronizar(urlApi);
    programarInsistencia();
  }, espera);
}

/**
 * Se sondea solo lo recien enviado. Pasada la ventana, un acuse ya no le sirve
 * al guardia que esta en terreno y seguir preguntando solo gasta bateria y
 * datos; el acuse igual queda registrado del lado del supervisor.
 */
function esperandoAcuse(alerta: AlertaPanico): boolean {
  if (alerta.estado !== 'entregado' || !alerta.eventId) return false;
  const desde = Date.parse(alerta.disparadaAt);
  if (Number.isNaN(desde)) return false;
  return Date.now() - desde < VENTANA_ACUSE_MS;
}

function programarAcuse(): void {
  if (typeof window === 'undefined' || temporizadorAcuse !== null) return;
  if (lectorAcuse === undefined) return;
  if (!cargar().some(esperandoAcuse)) return;

  temporizadorAcuse = window.setTimeout(() => {
    temporizadorAcuse = null;
    void consultarAcuses().finally(programarAcuse);
  }, ESPERA_ACUSE_MS);
}

async function consultarAcuses(): Promise<void> {
  const leer = lectorAcuse;
  if (!leer) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  for (const alerta of cargar()) {
    if (!esperandoAcuse(alerta) || !alerta.eventId) continue;
    const acuse = await leer(alerta.eventId).catch(() => undefined);
    if (!acuse) continue;
    actualizar(alerta.clientEventId, (actual) => ({
      ...actual,
      estado: 'acusado',
      ...(acuse.porQuien ? { acusadaPor: acuse.porQuien } : {}),
      ...(acuse.enAt ? { acusadaAt: acuse.enAt } : {}),
    }));
  }
}

/**
 * Arranca la entrega garantizada. Idempotente: una segunda llamada devuelve una
 * baja que no hace nada, igual que `iniciarAutoSync`.
 *
 * Se engancha a tres disparadores porque en terreno son los tres que importan:
 * el temporizador, la vuelta de la senal y la vuelta de la pantalla al frente
 * (un WebView en segundo plano no ejecuta timers).
 */
export function iniciarPanico(opciones: {
  apiUrl: string;
  segundosReintento: number;
}): () => void {
  urlApi = opciones.apiUrl;
  segundosInsistencia = opciones.segundosReintento;
  if (typeof window === 'undefined' || activo) return () => undefined;
  activo = true;

  bajaVeredictos = suscribirVeredictos((veredictos) => {
    for (const veredicto of veredictos) {
      const alerta = cargar().find((item) => item.clientEventId === veredicto.clientId);
      if (!alerta || alerta.estado !== 'encolado') continue;

      if (veredicto.status === 'rechazado') {
        actualizar(alerta.clientEventId, (actual) => ({
          ...actual,
          estado: 'rechazado',
          ...(veredicto.reason ? { motivo: veredicto.reason } : {}),
        }));
        continue;
      }
      // 'aplicado' y 'duplicado' son el mismo desenlace: esta en el servidor.
      // El veredicto no dice si se aviso a alguien, asi que `avisado` no se toca.
      actualizar(alerta.clientEventId, (actual) => ({
        ...actual,
        estado: 'entregado',
        ...(veredicto.serverId ? { eventId: veredicto.serverId } : {}),
      }));
    }
    programarAcuse();
  });

  const alVolverLaRed = () => reintentarAhora();
  const alVolverAlFrente = () => {
    if (document.visibilityState === 'visible' && haySinEntregar()) reintentarAhora();
  };

  window.addEventListener('online', alVolverLaRed);
  document.addEventListener('visibilitychange', alVolverAlFrente);

  void recuperarPendientes();
  programarInsistencia();
  programarAcuse();

  return () => {
    activo = false;
    window.removeEventListener('online', alVolverLaRed);
    document.removeEventListener('visibilitychange', alVolverAlFrente);
    bajaVeredictos?.();
    bajaVeredictos = null;
    if (temporizadorInsistencia !== null) {
      window.clearTimeout(temporizadorInsistencia);
      temporizadorInsistencia = null;
    }
    if (temporizadorAcuse !== null) {
      window.clearTimeout(temporizadorAcuse);
      temporizadorAcuse = null;
    }
  };
}
