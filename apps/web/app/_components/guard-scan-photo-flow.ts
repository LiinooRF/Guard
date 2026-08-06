'use client';

import type { FotoPendiente } from './guard-photo-store';
import type { EstadoRonda } from './guard-shift-state';

/**
 * El camino de la foto obligatoria de un PUNTO: procesarla, dejarla a salvo y
 * colgarla del escaneo.
 *
 * Vive fuera de `guard-shift.tsx` para poder probarlo. La pantalla del guardia
 * no tiene pruebas de renderizado —`apps/web/jest.config.js` corre solo
 * `*.spec.ts`, sin jsdom, y es a propósito— y esta es justo la parte que no se
 * puede dejar sin prueba: es evidencia, y una foto perdida no se puede volver a
 * tomar porque un punto ya escaneado nunca vuelve a ser el siguiente.
 *
 * ## El bug que este archivo existe para que no vuelva
 *
 * Entre que el guardia confirma la foto y la foto queda guardada pasan
 * SEGUNDOS: `procesarFoto()` decodifica una imagen de 12 MP, la reescala, le
 * quema la marca de agua y prueba varias calidades de JPEG. En esa ventana la
 * cámara devolvió el WebView al frente, `visibilitychange` disparó la
 * sincronización y el veredicto de `POST /sync/push` llegó con el id del
 * escaneo.
 *
 * Ese veredicto pasa UNA SOLA VEZ: `aplicarVeredictos()` de `guard-outbox` saca
 * de la cola la operación aplicada y solo deja las rechazadas, así que no se
 * reenvía. Su `fijarServerId()` corrió cuando la foto todavía no existía en el
 * almacén, y `fijarServerId` es un no-op silencioso si no encuentra el registro.
 * Si después la foto se guarda con el id que el flujo capturó al empezar —o sea
 * `null`— queda esperando un veredicto que ya pasó: el efecto de montaje solo
 * sube las que ya tienen `serverId`. La foto obligatoria del acceso crítico no
 * llega nunca y el punto queda «Falta la foto» para siempre.
 *
 * Por eso el id NO se arrastra desde que el flujo empezó: se relee del registro
 * en vivo, dos veces —antes de guardar y con la foto ya guardada—, y el estado
 * de la ronda queda como reparación en frío (`fotosDePuntoAdoptables`).
 */

/** El punto recién marcado que todavía debe su foto obligatoria. */
export interface FotoDePunto {
  checkpointId: string;
  nombre: string;
  clientScanId: string;
  /** `undefined` mientras el escaneo viaja en la cola: llega con el veredicto. */
  scanId?: string;
}

/**
 * Los ids de escaneo que el servidor ya devolvió, por id de cliente.
 *
 * Existe aparte del estado de React porque quien lo tiene que leer es una
 * función async que empezó ANTES de que el veredicto llegara: lo que capturó al
 * entrar es de hace segundos y no sirve para decidir dónde cuelga la foto.
 */
export interface RegistroIdsDeEscaneo {
  /** El servidor devolvió el id de este escaneo. */
  anotar(clientScanId: string, scanId: string): void;
  /** El id que se sabe EN ESTE INSTANTE, o `undefined` si todavía no llegó. */
  resolver(clientScanId: string): string | undefined;
}

export function nuevoRegistroIdsDeEscaneo(): RegistroIdsDeEscaneo {
  const porCliente = new Map<string, string>();
  return {
    anotar: (clientScanId, scanId) => {
      porCliente.set(clientScanId, scanId);
    },
    resolver: (clientScanId) => porCliente.get(clientScanId),
  };
}

export interface DependenciasFotoDePunto {
  /** Marca de agua y compresión. Es el `await` largo, el que abre la ventana. */
  procesar(archivo: File): Promise<Blob>;
  /** Deja la foto a salvo en el almacén persistente ANTES de intentar subirla. */
  guardar(clientScanId: string, foto: Blob, tomadaAt: string, scanId: string | null): Promise<void>;
  /** Le pone el id a una foto YA guardada. Reescribe el registro entero. */
  fijarId(clientScanId: string, scanId: string): Promise<void>;
  /** `undefined` = la foto ya no estaba: otro camino la subió y la borró. */
  subir(clientScanId: string, scanId: string): Promise<boolean | undefined>;
  /** El id del escaneo LEÍDO AHORA, no el que traía el panel al abrirse. */
  idDelEscaneo(clientScanId: string): string | undefined;
  /** Aviso de «la foto ya está a salvo», para refrescar el conteo de pendientes. */
  alGuardar?(): void | Promise<void>;
}

export interface DesenlaceFotoDePunto {
  /**
   * `esperando_id` — a salvo en el teléfono; sube sola cuando la cola traiga el id.
   * `subida`       — el servidor la tiene.
   * `sin_subir`    — guardada y no subida; se reintenta sola.
   */
  clase: 'esperando_id' | 'subida' | 'sin_subir';
  /**
   * Lo que devolvió la subida, para marcar el punto. `undefined` = no hay nada
   * que marcar acá: la foto ya no estaba, así que la marcó quien la subió.
   */
  subida?: boolean;
}

/**
 * Procesa la foto, la guarda y la sube si ya hay dónde colgarla.
 *
 * El orden importa y es el mismo de siempre: primero a salvo en el teléfono,
 * después la red. Lo que cambia es CUÁNDO se decide el id del escaneo — ver el
 * comentario de arriba.
 */
export async function guardarYSubirFotoDePunto(
  pendiente: FotoDePunto,
  archivo: File,
  tomadaAt: string,
  deps: DependenciasFotoDePunto,
): Promise<DesenlaceFotoDePunto> {
  const foto = await deps.procesar(archivo);

  // Primera relectura. Guardar con el id que traía `pendiente` al empezar es lo
  // que perdía la foto: en esos segundos el veredicto pudo traerlo.
  const idAlGuardar = pendiente.scanId ?? deps.idDelEscaneo(pendiente.clientScanId);
  await deps.guardar(pendiente.clientScanId, foto, tomadaAt, idAlGuardar ?? null);
  await deps.alGuardar?.();

  // Segunda relectura, ya con la foto en el almacén. Cierra la rendija que dejan
  // los `await` de arriba: si el veredicto entró justo ahí, su `fijarServerId()`
  // tampoco encontró el registro y no dejó nada fijado.
  const scanId = idAlGuardar ?? deps.idDelEscaneo(pendiente.clientScanId);
  if (scanId === undefined) return { clase: 'esperando_id' };

  // El id llegó tarde: la foto se guardó con `null` y hay que dejárselo escrito
  // ANTES de subir, para que el reintento al reabrir la app la encuentre lista
  // en vez de esperando un veredicto que ya pasó. Si ya se guardó con su id no
  // se reescribe: el registro lleva el blob, y son megas en un teléfono de gama
  // baja.
  if (idAlGuardar === undefined) await deps.fijarId(pendiente.clientScanId, scanId);

  const subida = await deps.subir(pendiente.clientScanId, scanId);
  if (subida === false) return { clase: 'sin_subir', subida: false };
  return subida === undefined ? { clase: 'subida' } : { clase: 'subida', subida };
}

/**
 * Qué tiene que hacer la PANTALLA con el desenlace de la foto.
 *
 * Vive acá y no dentro del componente por la misma razón que todo lo demás de
 * este archivo: `apps/web` no renderiza en las pruebas, y esta decisión ya se
 * equivocó de la peor forma posible. El panel se cerraba —`setFotoDePunto(undefined)`—
 * ANTES de escribir el aviso de «no se pudo subir», y ese aviso solo se pinta
 * DENTRO del panel: se escribía en un componente que en el mismo renderizado
 * dejaba de existir. El guardia veía desaparecer la cámara sin una palabra y se
 * iba creyendo que la foto había llegado. Y como un punto ya marcado nunca
 * vuelve a ser el siguiente, tampoco tenía cómo repetirla en toda la ronda: la
 * foto obligatoria del acceso crítico se perdía en silencio.
 *
 * La invariante que fija la prueba es esa misma: **si hay aviso, el panel queda
 * abierto**. Un aviso escrito en un componente desmontado es un aviso que no
 * existe.
 */
export interface EfectoDelDesenlace {
  /** El panel sigue abierto: hay algo que ver y algo que el guardia puede rehacer. */
  readonly mantenerPanel: boolean;
  /** Aviso DENTRO del panel. Solo se ve si `mantenerPanel` es `true`. */
  readonly aviso?: string;
  /** Para la región viva de la lista de puntos, que está siempre montada. */
  readonly anuncio: string;
  /** La foto está en el teléfono y el servidor todavía no la tiene. */
  readonly guardadaSinSubir: boolean;
}

export function efectoDelDesenlace(
  desenlace: DesenlaceFotoDePunto,
  nombrePunto: string,
): EfectoDelDesenlace {
  if (desenlace.clase === 'sin_subir') {
    // Guardada y no subida. Se reintenta sola, pero el guardia se tiene que
    // enterar y poder repetirla ahora, no descubrirlo al final del turno.
    return {
      mantenerPanel: true,
      guardadaSinSubir: true,
      aviso: 'La foto quedó guardada, pero no se pudo subir. Se envía sola después.',
      anuncio: `La foto de ${nombrePunto} quedó guardada en el teléfono. Todavía no se pudo subir.`,
    };
  }

  if (desenlace.clase === 'esperando_id') {
    // El escaneo todavía viaja en la cola. La foto espera en el teléfono y sale
    // sola cuando el veredicto de la sincronización traiga el id del escaneo.
    return {
      mantenerPanel: false,
      guardadaSinSubir: false,
      anuncio: 'Foto guardada. Se sube junto con el punto cuando vuelva la señal.',
    };
  }

  return { mantenerPanel: false, guardadaSinSubir: false, anuncio: 'Foto del punto registrada.' };
}

/**
 * Fotos de punto que quedaron guardadas sin el id del escaneo y que YA se pueden
 * subir, porque el estado de la ronda —que sí persiste, y que
 * `aplicarVeredictos()` completa con el `scanId`— ya lo sabe.
 *
 * Es la reparación en frío. El registro en vivo muere con el WebView, así que si
 * una foto llegó a quedar huérfana esta es la única forma de que salga: se corre
 * al montar la pantalla. Sin ella, una foto sin `serverId` no la reclama nadie.
 */
export function fotosDePuntoAdoptables(
  pendientes: readonly FotoPendiente[],
  registros: EstadoRonda['puntos'],
): { clientScanId: string; scanId: string }[] {
  const idPorEscaneo = new Map<string, string>();
  for (const registro of Object.values(registros)) {
    if (registro.scanId) idPorEscaneo.set(registro.clientScanId, registro.scanId);
  }

  const adoptables: { clientScanId: string; scanId: string }[] = [];
  for (const foto of pendientes) {
    // Con `serverId` ya la sube el camino de siempre. Y la foto de una novedad
    // cuelga del evento, no de un escaneo: acá no se toca.
    if (foto.serverId) continue;
    if (foto.destino !== 'escaneo') continue;
    const scanId = idPorEscaneo.get(foto.clientEventId);
    if (scanId !== undefined) adoptables.push({ clientScanId: foto.clientEventId, scanId });
  }
  return adoptables;
}
