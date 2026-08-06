'use client';

/**
 * Persistencia de las fotos de evidencia que todavía no llegaron al servidor
 * (#70).
 *
 * El problema que resuelve: hasta ahora la foto de una novedad vivía en un `Map`
 * en memoria. Si el guardia cerraba el WebView antes de recuperar señal, la foto
 * se perdía —el texto no, ese ya iba a la cola persistente— y la evidencia del
 * turno quedaba incompleta sin que nadie se enterara.
 *
 * Se usa **IndexedDB y no localStorage** porque una foto pesa megas y
 * localStorage solo guarda strings de unos pocos MB: meter la foto ahí llenaría
 * la cuota y tumbaría también la cola de texto. IndexedDB guarda Blobs binarios
 * sin serializar a base64.
 *
 * Degrada con gracia igual que `guard-storage`: si el WebView tiene IndexedDB
 * bloqueado por política del dispositivo, se cae a un `Map` en memoria. Perder
 * la foto al cerrar la app es malo, pero romper la pantalla en terreno es peor.
 *
 * Lo que NO hace: subir en segundo plano con la app **cerrada**. Eso necesita el
 * shell nativo (WorkManager + base cifrada, #71/#72) y vive en `apps/mobile`.
 * Esta pieza cubre "sobrevive al cierre/recarga del WebView y se sube al
 * reabrir o al recuperar señal".
 */

const NOMBRE_BD = 'voxia.guard.fotos';
const ALMACEN = 'fotos';
const VERSION_BD = 1;

/**
 * A qué cuelga la foto, que es lo que decide el endpoint de subida:
 * `/evidence/events/:id/photos` o `/evidence/scans/:id/photos`.
 *
 * Antes solo existían las de novedad, así que un registro guardado por una
 * versión anterior no trae el campo: al leerlo se asume `'evento'`, que es lo
 * que era. Por eso tampoco sube la versión de la base — cambiar el `keyPath`
 * sería una migración, y perder fotos pendientes al actualizar es exactamente
 * lo que este almacén existe para evitar.
 */
export type DestinoFoto = 'evento' | 'escaneo';

export interface FotoPendiente {
  /**
   * Id de cliente de la operación a la que cuelga la foto: `clientEventId` en
   * una novedad y `clientScanId` en un escaneo. El nombre quedó del primer caso
   * porque es el `keyPath` de la base ya creada en los teléfonos.
   */
  clientEventId: string;
  /** `null` hasta que la operación sincroniza y el servidor devuelve su id. */
  serverId: string | null;
  takenAtDevice: string;
  destino: DestinoFoto;
}

interface RegistroFoto extends FotoPendiente {
  blob: Blob;
}

/**
 * Reparte las pendientes entre las que ya se pueden subir (tienen `serverId`) y
 * las que todavía esperan que su novedad sincronice. Es lógica pura para poder
 * probarla sin IndexedDB.
 */
export function clasificarPendientes(pendientes: readonly FotoPendiente[]): {
  listas: FotoPendiente[];
  esperando: FotoPendiente[];
} {
  const listas: FotoPendiente[] = [];
  const esperando: FotoPendiente[] = [];
  for (const foto of pendientes) {
    (foto.serverId ? listas : esperando).push(foto);
  }
  return { listas, esperando };
}

// ------------------------------------------------------- respaldo en memoria

/** Se usa solo si IndexedDB no está disponible. */
const memoria = new Map<string, RegistroFoto>();
let indexedDbUtilizable: boolean | undefined;

function hayIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolver, rechazar) => {
    const solicitud = indexedDB.open(NOMBRE_BD, VERSION_BD);
    solicitud.onupgradeneeded = () => {
      const bd = solicitud.result;
      if (!bd.objectStoreNames.contains(ALMACEN)) {
        bd.createObjectStore(ALMACEN, { keyPath: 'clientEventId' });
      }
    };
    solicitud.onsuccess = () => resolver(solicitud.result);
    solicitud.onerror = () => rechazar(solicitud.error);
  });
}

async function conAlmacen<T>(
  modo: IDBTransactionMode,
  fn: (almacen: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const bd = await abrir();
  try {
    return await new Promise<T>((resolver, rechazar) => {
      const tx = bd.transaction(ALMACEN, modo);
      const solicitud = fn(tx.objectStore(ALMACEN));
      solicitud.onsuccess = () => resolver(solicitud.result);
      solicitud.onerror = () => rechazar(solicitud.error);
    });
  } finally {
    bd.close();
  }
}

/**
 * Corre la operación contra IndexedDB y, si falla o no existe, contra el `Map`
 * en memoria. Una vez que IndexedDB falla se marca inutilizable para no reintentar
 * en cada acción.
 */
async function conRespaldo<T>(
  operacionIdb: () => Promise<T>,
  operacionMemoria: () => T,
): Promise<T> {
  if (indexedDbUtilizable === false || !hayIndexedDb()) return operacionMemoria();
  try {
    const resultado = await operacionIdb();
    indexedDbUtilizable = true;
    return resultado;
  } catch {
    indexedDbUtilizable = false;
    return operacionMemoria();
  }
}

function metadatos({
  clientEventId,
  serverId,
  takenAtDevice,
  destino,
}: RegistroFoto): FotoPendiente {
  // `destino` puede faltar en un registro escrito por la versión anterior:
  // entonces era siempre la foto de una novedad.
  return { clientEventId, serverId, takenAtDevice, destino: destino ?? 'evento' };
}

// ------------------------------------------------------------- API pública

/** Guarda (o reemplaza) una foto de evidencia todavía sin subir. */
export function guardarFoto(
  clientEventId: string,
  blob: Blob,
  takenAtDevice: string,
  serverId: string | null = null,
  destino: DestinoFoto = 'evento',
): Promise<void> {
  const registro: RegistroFoto = { clientEventId, blob, serverId, takenAtDevice, destino };
  return conRespaldo(
    async () => {
      await conAlmacen('readwrite', (almacen) => almacen.put(registro));
    },
    () => {
      memoria.set(clientEventId, registro);
    },
  );
}

/** Fija el id de servidor una vez que la operación sincronizó. */
export async function fijarServerId(clientEventId: string, serverId: string): Promise<void> {
  const registro = await conRespaldo(
    () => conAlmacen<RegistroFoto | undefined>('readonly', (a) => a.get(clientEventId)),
    () => memoria.get(clientEventId),
  );
  if (!registro) return;
  await guardarFoto(
    clientEventId,
    registro.blob,
    registro.takenAtDevice,
    serverId,
    registro.destino ?? 'evento',
  );
}

/** Devuelve el Blob de la foto, o `undefined` si ya no está. */
/**
 * Devuelve la foto CON su hora de captura.
 *
 * Devolver solo el blob era el bug: quien subia ponia `new Date()`, o sea la
 * hora en que hubo señal. En un producto cuyo sentido es demostrar que alguien
 * estuvo en un lugar A UNA HORA, esa diferencia no es un detalle: una ronda
 * hecha a las 03:00 y sincronizada a las 07:00 quedaba registrada a las 07:00.
 */
export function leerFoto(
  clientEventId: string,
): Promise<{ blob: Blob; takenAtDevice: string; destino: DestinoFoto } | undefined> {
  const leida = (registro: RegistroFoto | undefined) =>
    registro
      ? {
          blob: registro.blob,
          takenAtDevice: registro.takenAtDevice,
          destino: registro.destino ?? ('evento' as const),
        }
      : undefined;
  return conRespaldo(
    async () =>
      leida(await conAlmacen<RegistroFoto | undefined>('readonly', (a) => a.get(clientEventId))),
    () => leida(memoria.get(clientEventId)),
  );
}

/** Borra la foto: se llama recién cuando el servidor confirmó la subida. */
export function borrarFoto(clientEventId: string): Promise<void> {
  return conRespaldo(
    async () => {
      await conAlmacen('readwrite', (almacen) => almacen.delete(clientEventId));
    },
    () => {
      memoria.delete(clientEventId);
    },
  );
}

/**
 * Subidas en curso, por foto. La MISMA foto no se manda dos veces a la vez: si
 * dos caminos la agarran juntos, el segundo espera el desenlace del primero.
 *
 * No es teórico. Cuando el veredicto de la cola llega mientras la foto del punto
 * todavía se procesa, quedan dos caminos con el id del escaneo en la mano y los
 * dos a punto de subirla. Y el segundo POST no es inofensivo: la API rechaza con
 * 409 el sha256 repetido —imagen reusada es LA marca de fraude de evidencia—,
 * así que volvería como "no se pudo subir" y dejaría al guardia viendo «Falta la
 * foto» de una foto que el servidor sí tiene.
 */
const subidasEnCurso = new Map<string, Promise<boolean | undefined>>();

/**
 * Corre la subida de esta foto una sola vez: quien llegue mientras está en vuelo
 * recibe la misma promesa y, por lo tanto, el mismo desenlace.
 */
export function conSubidaExclusiva(
  clientEventId: string,
  subir: () => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  const enCurso = subidasEnCurso.get(clientEventId);
  if (enCurso) return enCurso;

  const subida = subir().finally(() => {
    subidasEnCurso.delete(clientEventId);
  });
  subidasEnCurso.set(clientEventId, subida);
  return subida;
}

/** Metadatos de todas las fotos pendientes, sin cargar los Blobs. */
export function listarPendientes(): Promise<FotoPendiente[]> {
  return conRespaldo(
    async () => {
      const registros = await conAlmacen<RegistroFoto[]>('readonly', (a) => a.getAll());
      return registros.map(metadatos);
    },
    () => Array.from(memoria.values(), metadatos),
  );
}

/** Cuántas fotos quedan por subir, para mostrárselo al guardia. */
export async function contarPendientes(): Promise<number> {
  return (await listarPendientes()).length;
}

/** Solo para pruebas: vacía el respaldo en memoria entre casos. */
export function _reiniciarMemoria(): void {
  memoria.clear();
  subidasEnCurso.clear();
  indexedDbUtilizable = undefined;
}
