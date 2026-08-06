'use client';

import {
  DEFAULT_PATROL_RULES,
  isPhotoRequired,
  type CheckpointKind,
  type PatrolRules,
  type ScanAnomaly,
} from '@voxia/shared';

import { borrarClave, escribirJson, leerJson } from './guard-storage';
import type { MetodoEscaneo } from './guard-escaneo-modelo';
import type { Criticidad, VeredictoSync } from './guard-outbox';

/**
 * Estado de la ronda tal como lo ve el teléfono (#91, #93).
 *
 * Son funciones puras más la persistencia local. Existen separadas del
 * componente por dos razones concretas:
 *
 * 1. `GET /guard/home` no devuelve qué puntos ya se escanearon
 *    (`completedCheckpointCount` viene fijo en 0), así que si el WebView se
 *    cierra a mitad de ronda la única memoria es esta. Ver INTEGRACION.md.
 * 2. Cada punto tiene DOS estados y hay que distinguirlos: lo que pasó en
 *    terreno (pendiente / escaneado / con anomalía) y si eso ya está en el
 *    servidor (`confirmado`). Mezclarlos es lo que hace que el guardia repita
 *    escaneos o dé por perdido lo que sí se guardó.
 */

const CLAVE_RONDA = 'voxia.guard.patrol.v1';

/** Textos en español de las marcas de `scanAnomalySchema`. El sistema marca, no rechaza. */
const ETIQUETAS_ANOMALIA: Record<ScanAnomaly, string> = {
  fuera_de_radio_gps: 'Fuera del radio GPS del punto',
  sin_fix_gps: 'Sin señal de GPS al escanear',
  velocidad_imposible: 'Tiempo imposible entre dos puntos',
  reloj_desfasado: 'Reloj del teléfono desfasado',
  dispositivo_duplicado: 'Otro dispositivo escaneó en tu nombre',
  firma_dispositivo_ausente: 'Escaneo de una versión antigua sin firma del dispositivo',
};

/**
 * Una versión más nueva del servidor puede mandar una marca que este build no
 * conoce; se muestra genérica en vez de desaparecer, porque una anomalía oculta
 * es exactamente la falsa sensación de control que el producto evita.
 */
export function describirAnomalia(codigo: string): string {
  const conocida = (ETIQUETAS_ANOMALIA as Record<string, string | undefined>)[codigo];
  return conocida ?? 'Observación registrada por el servidor';
}

export interface PuntoRuta {
  id: string;
  name: string;
  position: number;
  /** Al escanearlo, el servidor cierra la ronda. Llega en `GET /guard/home`. */
  isClosingPoint?: boolean;
  /**
   * `acceso_critico` = puerta, portería o acceso. Es el punto donde además de
   * marcar hay que fotografiar el estado de la puerta. Llega en `GET /guard/home`.
   */
  kind?: CheckpointKind;
  /** Override tri-estado del punto: `true`/`false` pisan la regla, `null` hereda. */
  requiresPhoto?: boolean | null;
  /** Coordenadas para el visor de ruta (#76). `null`/ausente = punto sin ubicar. */
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Lo que hace falta, además del punto, para saber si toca fotografiar. Llega
 * resuelto por la API en `GET /guard/home` (`photoPolicy`): el horario hábil se
 * calcula en la zona del RECINTO y con sus feriados, cosa que el teléfono no
 * puede hacer solo.
 */
export interface PoliticaFoto {
  withinBusinessHours: boolean;
  /** Instante en que la API evaluó el horario. Una ronda larga lo puede cruzar. */
  evaluatedAt?: string;
  rules: Pick<PatrolRules, 'photoRequiredOutsideHours' | 'photoRequiredOnCritical'>;
}

/**
 * ¿Este punto exige foto? La decisión NO se reimplementa acá: se delega en
 * `isPhotoRequired()` de `@voxia/shared`, que es la misma función que corre en
 * el servidor. Esto solo adapta la forma del punto que manda la API.
 *
 * Sin `politica` —API vieja frente a un portal nuevo— se asume horario hábil.
 * Así siguen pidiendo foto los accesos críticos y los puntos con override, que
 * es el mínimo que promete el producto, en vez de pedirla en los 40 puntos de
 * la ronda y hacer que el guardia deje de creerle a la pantalla.
 */
export function puntoExigeFoto(punto: PuntoRuta, politica?: PoliticaFoto): boolean {
  return isPhotoRequired({
    checkpoint: {
      kind: punto.kind ?? 'normal',
      requiresPhoto: punto.requiresPhoto ?? null,
    },
    withinBusinessHours: politica?.withinBusinessHours ?? true,
    rules: politica?.rules ?? DEFAULT_PATROL_RULES,
  });
}

export type EstadoPunto = 'pendiente' | 'escaneado' | 'con_anomalia';

export interface RegistroPunto {
  estado: EstadoPunto;
  /** `false` = el escaneo está en la cola y el servidor todavía no lo vio. */
  confirmado: boolean;
  anomalias: string[];
  scannedAt: string;
  clientScanId: string;
  /**
   * Cómo se marcó el punto (#227). Opcional porque las rondas a medias que ya
   * están guardadas en el teléfono se escribieron sin este campo: ahí queda
   * `undefined` y la pantalla NO inventa un método. Decir "NFC" sin saberlo
   * sería exactamente lo que este campo existe para evitar — que un escaneo por
   * QR, que es evidencia más débil, pase por uno de etiqueta.
   */
  metodo?: MetodoEscaneo;
  /**
   * Si al escanear este punto tocaba fotografiar. Se congela con el registro: la
   * deuda de evidencia es del momento en que el guardia estuvo ahí, y no puede
   * desaparecer sola porque más tarde el recinto abriera.
   */
  fotoRequerida?: boolean;
  /** `true` recién cuando el servidor recibió la foto de ESTE escaneo. */
  fotoSubida?: boolean;
  /** Id del escaneo en el servidor. Sin él la foto no tiene dónde colgarse. */
  scanId?: string;
}

/**
 * Puntos ya escaneados que debían foto y todavía no la tienen arriba. Es la
 * deuda de evidencia del turno: se muestra en la lista y en el resumen, porque
 * una foto obligatoria que nadie reclama es lo mismo que no exigirla.
 */
export function puntosSinFoto(
  puntos: readonly PuntoRuta[],
  registros: EstadoRonda['puntos'],
): PuntoRuta[] {
  return puntos.filter((punto) => {
    const registro = registros[punto.id];
    return registro !== undefined && registro.fotoRequerida === true && !registro.fotoSubida;
  });
}

export interface NovedadLocal {
  clientEventId: string;
  criticidad: Criticidad;
  texto?: string;
  reportadaAt: string;
  confirmada: boolean;
  /** El servidor dice si había a quién avisar. `false` con criticidad alta importa. */
  notificada: boolean;
  conFoto: boolean;
  fotoSubida: boolean;
}

export interface CierreRonda {
  cerradaAt: string;
  scanned: number;
  expected: number;
  /** Ids de los puntos que quedaron sin escanear. */
  faltantes: string[];
  /** Solo cuando lo calculó el servidor: el porcentaje no se estima en el teléfono. */
  pct?: number;
  alertaEnviada: boolean;
  confirmado: boolean;
  /** Escaneo que cerró la ronda. Es lo que permite confirmar el cierre al sincronizar. */
  clientScanId?: string;
}

export interface EstadoRonda {
  patrolId: string;
  puntos: Record<string, RegistroPunto>;
  novedades: NovedadLocal[];
  cierre?: CierreRonda;
}

export function estadoInicial(patrolId: string): EstadoRonda {
  return { patrolId, puntos: {}, novedades: [] };
}

export function cargarEstadoRonda(patrolId: string): EstadoRonda {
  const guardado = leerJson<EstadoRonda | null>(`${CLAVE_RONDA}:${patrolId}`, null);
  return guardado && guardado.patrolId === patrolId ? guardado : estadoInicial(patrolId);
}

export function guardarEstadoRonda(estado: EstadoRonda): void {
  escribirJson(`${CLAVE_RONDA}:${estado.patrolId}`, estado);
}

/**
 * Se llama solo cuando la ronda cerró Y todo lo suyo está confirmado en el
 * servidor. Antes de eso, borrar es perder el trabajo del guardia.
 */
export function olvidarEstadoRonda(patrolId: string): void {
  borrarClave(`${CLAVE_RONDA}:${patrolId}`);
}

export function registrarEscaneo(
  estado: EstadoRonda,
  entrada: {
    checkpointId: string;
    clientScanId: string;
    anomalias: readonly string[];
    confirmado: boolean;
    scannedAt: string;
    metodo: MetodoEscaneo;
    /** Si este punto exigía foto. Queda escrito con el registro. */
    fotoRequerida?: boolean;
    /** Id del escaneo en el servidor, cuando el escaneo se pudo mandar. */
    scanId?: string;
  },
): EstadoRonda {
  return {
    ...estado,
    puntos: {
      ...estado.puntos,
      [entrada.checkpointId]: {
        estado: entrada.anomalias.length ? 'con_anomalia' : 'escaneado',
        confirmado: entrada.confirmado,
        anomalias: [...entrada.anomalias],
        scannedAt: entrada.scannedAt,
        clientScanId: entrada.clientScanId,
        metodo: entrada.metodo,
        ...(entrada.fotoRequerida === undefined ? {} : { fotoRequerida: entrada.fotoRequerida }),
        ...(entrada.scanId ? { scanId: entrada.scanId } : {}),
        fotoSubida: false,
      },
    },
  };
}

/** Cuantos puntos de la ronda se marcaron con el respaldo por QR (#227). */
export function puntosPorQr(estado: EstadoRonda): number {
  return Object.values(estado.puntos).filter((punto) => punto.metodo === 'qr').length;
}

/**
 * La foto del punto llegó al servidor (o no). Se busca por `clientScanId` y no
 * por el punto porque quien avisa es la cola de sincronización, que solo conoce
 * el id de cliente de la operación.
 */
export function marcarFotoPuntoSubida(
  estado: EstadoRonda,
  clientScanId: string,
  subida: boolean,
): EstadoRonda {
  const puntos = { ...estado.puntos };
  for (const [checkpointId, registro] of Object.entries(puntos)) {
    if (registro.clientScanId !== clientScanId) continue;
    puntos[checkpointId] = { ...registro, fotoSubida: subida };
  }
  return { ...estado, puntos };
}

export function registrarCierre(estado: EstadoRonda, cierre: CierreRonda): EstadoRonda {
  return { ...estado, cierre };
}

export function registrarNovedad(estado: EstadoRonda, novedad: NovedadLocal): EstadoRonda {
  return { ...estado, novedades: [novedad, ...estado.novedades] };
}

export function marcarFotoSubida(
  estado: EstadoRonda,
  clientEventId: string,
  subida: boolean,
): EstadoRonda {
  return {
    ...estado,
    novedades: estado.novedades.map((novedad) =>
      novedad.clientEventId === clientEventId ? { ...novedad, fotoSubida: subida } : novedad,
    ),
  };
}

/**
 * Reconcilia lo provisional con lo que dijo el servidor al sincronizar.
 *
 * `aplicado` y `duplicado` confirman igual: el reenvío de la cola es idempotente
 * y "ya estaba" es tan bueno como "recién entró". `rechazado` devuelve el punto
 * a pendiente — el motivo lo muestra la barra de conexión, no se pierde.
 */
export function aplicarVeredictos(
  estado: EstadoRonda,
  veredictos: readonly VeredictoSync[],
): EstadoRonda {
  let siguiente = estado;

  for (const veredicto of veredictos) {
    const confirmado = veredicto.status !== 'rechazado';

    const puntos = { ...siguiente.puntos };
    for (const [checkpointId, registro] of Object.entries(puntos)) {
      if (registro.clientScanId !== veredicto.clientId) continue;
      if (confirmado) {
        // El `serverId` del veredicto es el id del escaneo: es lo único que
        // permite subir después la foto que quedó guardada sin señal.
        puntos[checkpointId] = {
          ...registro,
          confirmado: true,
          ...(veredicto.serverId ? { scanId: veredicto.serverId } : {}),
        };
      } else {
        delete puntos[checkpointId];
      }
    }

    const novedades = siguiente.novedades.map((novedad) =>
      novedad.clientEventId === veredicto.clientId
        ? { ...novedad, confirmada: confirmado }
        : novedad,
    );

    const cierre = resolverCierre(siguiente.cierre, veredicto.clientId, confirmado);
    siguiente = {
      patrolId: siguiente.patrolId,
      puntos,
      novedades,
      ...(cierre ? { cierre } : {}),
    };
  }

  return siguiente;
}

/**
 * El cierre solo se resuelve con el veredicto de SU escaneo. Si ese fue
 * rechazado, la ronda nunca se cerró y la pantalla vuelve a la ejecución.
 */
function resolverCierre(
  cierre: CierreRonda | undefined,
  clientId: string,
  confirmado: boolean,
): CierreRonda | undefined {
  if (!cierre || cierre.clientScanId !== clientId) return cierre;
  return confirmado ? { ...cierre, confirmado: true } : undefined;
}

/** El punto al que el guardia tiene que ir ahora: el primero sin escanear. */
export function siguientePunto(
  puntos: readonly PuntoRuta[],
  registros: EstadoRonda['puntos'],
): PuntoRuta | undefined {
  return [...puntos]
    .sort((a, b) => a.position - b.position)
    .find((punto) => registros[punto.id] === undefined);
}

export function puntosFaltantes(
  puntos: readonly PuntoRuta[],
  registros: EstadoRonda['puntos'],
): PuntoRuta[] {
  return puntos.filter((punto) => registros[punto.id] === undefined);
}

/**
 * Trabajo que todavía no llegó al servidor.
 *
 * NO incluye la foto obligatoria que el guardia nunca llegó a tomar: eso es una
 * deuda de evidencia, no algo esperando en la cola, y contarlo acá dejaba el
 * turno sin poder cerrarse nunca. Las fotos tomadas y sin subir sí se cuentan,
 * pero desde el almacén persistente (`contarPendientes`), que es donde están.
 * La deuda se muestra aparte, con `puntosSinFoto()`.
 */
export function hayPendientesDeSubir(estado: EstadoRonda): boolean {
  const puntosPendientes = Object.values(estado.puntos).some((punto) => !punto.confirmado);
  const novedadesPendientes = estado.novedades.some((novedad) => !novedad.confirmada);
  return puntosPendientes || novedadesPendientes;
}

export const ETIQUETAS_CRITICIDAD: Record<Criticidad, string> = {
  info: 'Informativa',
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
  panico: 'PÁNICO',
};
