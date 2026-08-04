'use client';

import type { ScanAnomaly } from '@voxia/shared';

import { borrarClave, escribirJson, leerJson } from './guard-storage';
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
}

export type EstadoPunto = 'pendiente' | 'escaneado' | 'con_anomalia';

export interface RegistroPunto {
  estado: EstadoPunto;
  /** `false` = el escaneo está en la cola y el servidor todavía no lo vio. */
  confirmado: boolean;
  anomalias: string[];
  scannedAt: string;
  clientScanId: string;
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
      },
    },
  };
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
        puntos[checkpointId] = { ...registro, confirmado: true };
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
