'use client';

import { borrarClave, escribirJson, leerJson } from './guard-storage';

/**
 * Las tareas del turno, vistas desde el teléfono (#265).
 *
 * El requisito, textual del dueño del producto: *"tengo asignada una tarea de ir
 * A LAS 11, a CIERTO PUNTO, y tomar una IMAGEN al refrigerador… si la tarea queda
 * fuera del horario de la ronda, que se envíe igual"*. De ahí salen las tres
 * reglas que sostiene este archivo:
 *
 * 1. **Una tarea con punto se responde AL ESCANEAR ese punto**, no al final. El
 *    checklist de #129 se pedía en el resumen —o sea después del punto de
 *    cierre—, que es exactamente cuando ya no sirve: el refrigerador quedó tres
 *    pisos atrás. Las tareas sin punto (`checkpointId` nulo) siguen en el cierre,
 *    que es como funcionaban hasta hoy.
 * 2. **Nada se pierde sin señal.** `POST /sync/push` solo acepta `scan` y
 *    `event`, así que el checklist no viaja por esa cola: tiene la suya, acá,
 *    persistida en el teléfono y reintentada al recuperar conexión. La
 *    idempotencia es la misma del modelo —una respuesta por (ronda, item), con
 *    `ON CONFLICT DO NOTHING` en el servidor—, así que reenviar el lote entero es
 *    seguro.
 * 3. **La foto obligatoria viaja CON su respuesta o no viaja.** Es la regla que
 *    más fácil se rompe y la que más caro sale: si una respuesta que exige foto
 *    se mandara sin `photoId`, el servidor la aceptaría, y la segunda —la que sí
 *    trae la foto— chocaría contra el `ON CONFLICT` y se descartaría en silencio.
 *    La tarea quedaría respondida y sin evidencia PARA SIEMPRE, sin forma de
 *    corregirla desde la app.
 *
 * Todo lo de acá es función pura más la persistencia local, por la misma razón
 * que el resto del carril del guardia: `apps/web/jest.config.js` corre solo
 * `*.spec.ts` sin jsdom, así que lo que vive dentro de un componente no se puede
 * probar, y esto es evidencia.
 */

const CLAVE_PLANTILLA = 'sentrycore.guard.tareas.plantilla.v1';
const CLAVE_ESTADO = 'sentrycore.guard.tareas.v1';

export type TipoRespuestaTarea = 'ok_falla' | 'texto' | 'numero';

export interface ItemTarea {
  id: string;
  position: number;
  label: string;
  responseType: TipoRespuestaTarea;
  /** Foto solo al marcar falla. Es la que ya existía en #129. */
  requiresPhotoOnFail: boolean;
  /**
   * Dónde se hace. `null` (o ausente, si la API todavía no manda la columna) =
   * tarea general del turno: se responde en el cierre, como siempre.
   */
  checkpointId?: string | null;
  /**
   * A qué hora toca, en la zona del RECINTO y sin fecha ("11:00:00"). Acá solo
   * se MUESTRA: cuánto se atrasó una respuesta lo decide el servidor, que es el
   * único que sabe la zona del recinto y no le cree al reloj del teléfono.
   */
  dueLocalTime?: string | null;
  /** Foto SIEMPRE, esté todo bien o mal. Distinta de `requiresPhotoOnFail`. */
  requiresPhoto?: boolean;
}

export type PlantillaTareas =
  | { patrolId: string; hasChecklist: false }
  | {
      patrolId: string;
      hasChecklist: true;
      template: { id: string; name: string; items: ItemTarea[] };
    };

// ------------------------------------------------------- qué toca en qué punto

export function itemsDeLaPlantilla(plantilla: PlantillaTareas | undefined): ItemTarea[] {
  if (!plantilla || !plantilla.hasChecklist) return [];
  return [...plantilla.template.items].sort((a, b) => a.position - b.position);
}

/** Las tareas de ESE punto, en orden. Es lo que se muestra al marcarlo. */
export function tareasDelPunto(
  items: readonly ItemTarea[],
  checkpointId: string,
): ItemTarea[] {
  return items
    .filter((item) => item.checkpointId === checkpointId)
    .sort((a, b) => a.position - b.position);
}

/**
 * Las del cierre: las que NO tienen punto.
 *
 * El filtro no es cosmético. Sin él, una tarea con punto se ofrecería dos veces
 * —al escanear y otra vez en el resumen—, y la segunda respuesta chocaría con el
 * `ON CONFLICT` del servidor: el guardia la contestaría creyendo que hace algo.
 */
export function tareasDelCierre(items: readonly ItemTarea[]): ItemTarea[] {
  return items
    .filter((item) => !item.checkpointId)
    .sort((a, b) => a.position - b.position);
}

/**
 * ¿Esta respuesta necesita foto?
 *
 * `requiresPhoto` pide foto pase lo que pase —"fotografiar el refrigerador" es
 * evidencia del estado normal, no de una falla—; `requiresPhotoOnFail` solo
 * cuando se marca falla, que es la regla vieja y sigue valiendo.
 */
export function tareaExigeFoto(item: ItemTarea, valor: string | undefined): boolean {
  if (item.requiresPhoto === true) return true;
  return item.requiresPhotoOnFail && (valor ?? '').trim().toLowerCase() === 'falla';
}

// --------------------------------------------------------- la cola de la ronda

export interface RespuestaTareaEnCola {
  itemId: string;
  /** El punto donde se respondió; `null` = tarea del cierre. */
  checkpointId: string | null;
  value: string;
  notes?: string;
  /**
   * Hora del TELÉFONO al responder. **No viaja en el POST**: la API valida con
   * `forbidNonWhitelisted`, así que un campo que el DTO no declara devuelve 400
   * y se lleva el lote entero. Queda acá para que la pantalla pueda decir cuándo
   * se respondió mientras el servidor no acepte ese dato.
   */
  respondidaAt: string;
  /** Clave de la foto en el almacén persistente, si la tarea exige foto. */
  clientPhotoId?: string;
  /** Escaneo del punto: la foto de la tarea cuelga de él, igual que la del punto. */
  clientScanId?: string;
  /** Id de la foto YA subida. Sin él, una respuesta que exige foto no viaja. */
  photoId?: string;
  /** Esta respuesta no vale sin foto. Se congela al responder, con el valor dado. */
  exigeFoto: boolean;
  estado: 'pendiente' | 'rechazada';
  motivo?: string;
}

export interface EstadoTareas {
  patrolId: string;
  /** Lo respondido que todavía no aceptó el servidor. */
  cola: RespuestaTareaEnCola[];
  /** Items que el servidor ya tiene ('aplicado' o 'duplicado'): no se re-ofrecen. */
  enviadas: string[];
}

/** Lo que entra en `POST /checklists/patrols/:id/responses`, y nada más. */
export interface RespuestaParaEnviar {
  itemId: string;
  value: string;
  notes?: string;
  photoId?: string;
}

export interface ResultadoTarea {
  itemId: string;
  status: 'aplicado' | 'duplicado' | 'rechazado';
  reason?: string;
}

export function estadoTareasInicial(patrolId: string): EstadoTareas {
  return { patrolId, cola: [], enviadas: [] };
}

/**
 * Responde una tarea. Queda en la cola del teléfono, con señal o sin ella: quien
 * decide cuándo sale es `enviarPendientes`.
 *
 * Volver a responder algo que el servidor YA aceptó no hace nada. La primera
 * respuesta es la que vale —`ON CONFLICT (tenant_id, patrol_id, item_id) DO
 * NOTHING`—, así que encolar una segunda solo produciría un 'duplicado' y le
 * haría creer al guardia que corrigió algo.
 */
export function responderTarea(
  estado: EstadoTareas,
  entrada: {
    item: ItemTarea;
    value: string;
    notes?: string;
    respondidaAt: string;
    /** El escaneo del punto donde se respondió, para colgarle la foto. */
    clientScanId?: string;
    /** Clave de la foto ya tomada para esta tarea, si la hay. */
    clientPhotoId?: string;
    /** Id de servidor de esa foto, cuando ya subió. */
    photoId?: string;
  },
): EstadoTareas {
  if (estado.enviadas.includes(entrada.item.id)) return estado;

  const respuesta: RespuestaTareaEnCola = {
    itemId: entrada.item.id,
    checkpointId: entrada.item.checkpointId ?? null,
    value: entrada.value.trim(),
    ...(entrada.notes?.trim() ? { notes: entrada.notes.trim() } : {}),
    respondidaAt: entrada.respondidaAt,
    ...(entrada.clientScanId ? { clientScanId: entrada.clientScanId } : {}),
    ...(entrada.clientPhotoId ? { clientPhotoId: entrada.clientPhotoId } : {}),
    ...(entrada.photoId ? { photoId: entrada.photoId } : {}),
    exigeFoto: tareaExigeFoto(entrada.item, entrada.value),
    estado: 'pendiente',
  };

  // Corregirse antes de que salga sí se puede: esa respuesta todavía no llegó a
  // ninguna parte, así que la última pisa a la anterior y no se acumulan dos
  // respuestas del mismo item en la cola.
  return {
    ...estado,
    cola: [...estado.cola.filter((otra) => otra.itemId !== respuesta.itemId), respuesta],
  };
}

/**
 * La foto de la tarea llegó al servidor. Se busca por la clave del almacén y no
 * por el item porque quien avisa es la subida, que solo conoce esa clave.
 */
export function anotarFotoDeTarea(
  estado: EstadoTareas,
  clientPhotoId: string,
  photoId: string,
): EstadoTareas {
  return {
    ...estado,
    cola: estado.cola.map((respuesta) =>
      respuesta.clientPhotoId === clientPhotoId ? { ...respuesta, photoId } : respuesta,
    ),
  };
}

/**
 * Lo que se puede mandar AHORA.
 *
 * Deja fuera lo rechazado —reintentarlo daría el mismo error— y, sobre todo, la
 * respuesta que exige foto y todavía no tiene `photoId`: mandarla sin foto la
 * congelaría sin evidencia, porque la segunda no puede reescribirla. Espera en
 * la cola a que la foto suba; sale sola en el siguiente intento.
 */
export function loteParaEnviar(estado: EstadoTareas): RespuestaParaEnviar[] {
  return estado.cola
    .filter((respuesta) => respuesta.estado === 'pendiente')
    .filter((respuesta) => !respuesta.exigeFoto || respuesta.photoId !== undefined)
    .map((respuesta) => ({
      itemId: respuesta.itemId,
      value: respuesta.value,
      ...(respuesta.notes ? { notes: respuesta.notes } : {}),
      ...(respuesta.photoId ? { photoId: respuesta.photoId } : {}),
    }));
}

/**
 * Reconcilia con el veredicto por item del servidor.
 *
 * 'aplicado' y 'duplicado' son el mismo desenlace: el trabajo está en el
 * servidor y la respuesta sale de la cola. 'rechazado' se queda para que el
 * guardia vea el motivo, pero no se reintenta solo.
 */
export function aplicarResultadosTareas(
  estado: EstadoTareas,
  resultados: readonly ResultadoTarea[],
): EstadoTareas {
  const porItem = new Map(resultados.map((resultado) => [resultado.itemId, resultado]));
  const cola: RespuestaTareaEnCola[] = [];
  const enviadas = [...estado.enviadas];

  for (const respuesta of estado.cola) {
    const resultado = porItem.get(respuesta.itemId);
    if (!resultado) {
      cola.push(respuesta);
      continue;
    }
    if (resultado.status === 'rechazado') {
      cola.push({
        ...respuesta,
        estado: 'rechazada',
        ...(resultado.reason ? { motivo: resultado.reason } : {}),
      });
      continue;
    }
    if (!enviadas.includes(respuesta.itemId)) enviadas.push(respuesta.itemId);
  }

  return { ...estado, cola, enviadas };
}

/**
 * Manda lo que se pueda y devuelve el estado nuevo.
 *
 * Si no hay señal —`enviar` revienta o no devuelve veredictos— la cola queda
 * **intacta**: sin conexión no se pierde una sola respuesta, y el próximo
 * intento la vuelve a ofrecer. La idempotencia por (ronda, item) hace que
 * reenviar sea seguro aunque el lote anterior sí hubiera llegado.
 */
export async function enviarPendientes(
  estado: EstadoTareas,
  enviar: (lote: RespuestaParaEnviar[]) => Promise<readonly ResultadoTarea[] | undefined>,
): Promise<EstadoTareas> {
  const lote = loteParaEnviar(estado);
  if (!lote.length) return estado;

  let resultados: readonly ResultadoTarea[] | undefined;
  try {
    resultados = await enviar(lote);
  } catch {
    return estado;
  }
  if (!resultados) return estado;
  return aplicarResultadosTareas(estado, resultados);
}

/**
 * Fotos de tarea que quedaron guardadas sin el id de su escaneo y que YA se
 * pueden subir, porque el estado de la ronda —que sí persiste— ya lo sabe.
 *
 * Es la reparación en frío, la misma que `fotosDePuntoAdoptables` hace con la
 * foto del acceso, y hace falta por la misma razón: el veredicto de la
 * sincronización pasa UNA vez y muere con el WebView. Sin esto, una tarea
 * respondida sin señal se queda esperando una foto que nadie va a subir, y la
 * respuesta no sale nunca de la cola.
 *
 * Va por `clientScanId` y no por la clave de la foto: la foto de la tarea tiene
 * clave propia —si compartiera la del escaneo pisaría la foto del punto, que se
 * guarda con esa misma clave— y quien conoce el escaneo es la respuesta.
 */
export function fotosDeTareaAdoptables(
  estado: EstadoTareas,
  registros: Readonly<Record<string, { clientScanId: string; scanId?: string }>>,
): { clientPhotoId: string; scanId: string }[] {
  const idPorEscaneo = new Map<string, string>();
  for (const registro of Object.values(registros)) {
    if (registro.scanId) idPorEscaneo.set(registro.clientScanId, registro.scanId);
  }

  const adoptables: { clientPhotoId: string; scanId: string }[] = [];
  for (const respuesta of estado.cola) {
    // Con `photoId` ya está arriba; sin `clientPhotoId` no hay foto que subir.
    if (respuesta.photoId !== undefined) continue;
    if (!respuesta.clientPhotoId || !respuesta.clientScanId) continue;
    const scanId = idPorEscaneo.get(respuesta.clientScanId);
    if (scanId !== undefined) adoptables.push({ clientPhotoId: respuesta.clientPhotoId, scanId });
  }
  return adoptables;
}

// ------------------------------------------------------------- lo que falta

/** ¿Esta tarea ya está respondida (en la cola o aceptada)? */
export function tareaRespondida(estado: EstadoTareas, itemId: string): boolean {
  return (
    estado.enviadas.includes(itemId) ||
    estado.cola.some((respuesta) => respuesta.itemId === itemId)
  );
}

/** Las tareas de este punto que todavía hay que responder. */
export function tareasDelPuntoPorResponder(
  items: readonly ItemTarea[],
  estado: EstadoTareas,
  checkpointId: string,
): ItemTarea[] {
  return tareasDelPunto(items, checkpointId).filter(
    (item) => !tareaRespondida(estado, item.id),
  );
}

/**
 * Las del turno que quedaron sin responder. Se listan en el cierre igual que los
 * puntos sin foto: una tarea que nadie reclama es una tarea que no se exigió.
 */
export function tareasSinResponder(
  items: readonly ItemTarea[],
  estado: EstadoTareas,
): ItemTarea[] {
  return [...items]
    .sort((a, b) => a.position - b.position)
    .filter((item) => !tareaRespondida(estado, item.id));
}

/** Respuestas de tareas que todavía no llegaron al servidor. */
export function tareasPendientesDeSubir(estado: EstadoTareas): number {
  return estado.cola.filter((respuesta) => respuesta.estado === 'pendiente').length;
}

/** Respuestas que el servidor rechazó, con su motivo, para mostrárselas al guardia. */
export function tareasRechazadas(estado: EstadoTareas): RespuestaTareaEnCola[] {
  return estado.cola.filter((respuesta) => respuesta.estado === 'rechazada');
}

// -------------------------------------------------------------- persistencia

/**
 * La plantilla se guarda apenas se pide, y se pide al ENTRAR a la ronda.
 *
 * Antes se pedía en el resumen: en un subterráneo eso significa que la tarea del
 * punto 3 no existió nunca. Guardada, la ronda entera se puede hacer sin señal.
 */
export function guardarPlantillaTareas(patrolId: string, plantilla: PlantillaTareas): void {
  escribirJson(`${CLAVE_PLANTILLA}:${patrolId}`, plantilla);
}

export function cargarPlantillaTareas(patrolId: string): PlantillaTareas | undefined {
  const guardada = leerJson<PlantillaTareas | null>(`${CLAVE_PLANTILLA}:${patrolId}`, null);
  return guardada && guardada.patrolId === patrolId ? guardada : undefined;
}

export function cargarEstadoTareas(patrolId: string): EstadoTareas {
  const guardado = leerJson<EstadoTareas | null>(`${CLAVE_ESTADO}:${patrolId}`, null);
  return guardado && guardado.patrolId === patrolId ? guardado : estadoTareasInicial(patrolId);
}

export function guardarEstadoTareas(estado: EstadoTareas): void {
  escribirJson(`${CLAVE_ESTADO}:${estado.patrolId}`, estado);
}

/** Se llama solo cuando la ronda cerró y no queda nada por subir. */
export function olvidarEstadoTareas(patrolId: string): void {
  borrarClave(`${CLAVE_ESTADO}:${patrolId}`);
  borrarClave(`${CLAVE_PLANTILLA}:${patrolId}`);
}
