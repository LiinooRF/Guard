import { computeCompliance, type ComplianceResult, type ScanAnomaly } from '@voxia/shared';

import type { MarcaDocumento } from './pdf-primitivas';

/**
 * Composicion del informe de ronda: filas crudas de la base -> modelo listo
 * para dibujar (#85).
 *
 * Esta capa es PURA a proposito: no importa pdfkit, ni Nest, ni toca el disco.
 * Es donde vive lo que hay que poder testear —que filas salen, cual queda
 * marcada omitida, que pasa cuando falta una foto— sin depender de la libreria
 * de PDF ni de una base levantada.
 */

// --------------------------------------------------------------- filas crudas

export interface EncabezadoRondaRow {
  id: string;
  status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  closed_at: Date | null;
  compliance_pct: string | null;
  site_id: string;
  site_name: string;
  branch_name: string;
  timezone: string;
  route_name: string;
  guard_name: string;
}

export interface PuntoEsperadoRow {
  position: string;
  id: string;
  name: string;
  kind: string;
  is_closing_point: boolean;
}

export interface ScanRow {
  checkpoint_id: string;
  method: string;
  scanned_at_server: Date;
  scanned_at_device: Date | null;
  anomalies: ScanAnomaly[];
}

export interface FotoRow {
  id: string;
  checkpoint_id: string;
  checkpoint_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: string | number;
  sha256: string;
  taken_at_device: Date | null;
  created_at: Date;
}

export interface IncidenteRow {
  id: string;
  criticality: string;
  text: string | null;
  reported_at_server: Date;
}

// ------------------------------------------------------------------- modelo

export interface FilaPunto {
  readonly numero: number;
  readonly checkpointId: string;
  readonly nombre: string;
  readonly esCierre: boolean;
  readonly esCritico: boolean;
  /** Verdad unica del estado: sale de computeCompliance, no de un recuento local. */
  readonly omitido: boolean;
  readonly escaneadoEn: Date | null;
  readonly metodo: string | null;
  readonly anomalias: readonly ScanAnomaly[];
}

export interface FotoAnexo {
  readonly id: string;
  readonly checkpointId: string;
  readonly checkpointName: string;
  /** Numero del punto en la ronda, o null si la foto no corresponde a uno esperado. */
  readonly numeroPunto: number | null;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Prefijo del sha256: la huella que permite verificar que la imagen no cambio. */
  readonly huella: string;
  readonly capturadaEn: Date;
}

export interface IncidenteInforme {
  readonly id: string;
  readonly criticidad: string;
  readonly texto: string;
  readonly reportadoEn: Date;
  readonly destacado: boolean;
}

export interface InformeRonda {
  readonly patrolId: string;
  readonly filename: string;
  readonly marca: MarcaDocumento;
  readonly timezone: string;
  readonly recinto: {
    readonly nombre: string;
    readonly sucursal: string;
    readonly ruta: string;
    readonly guardia: string;
  };
  readonly ventana: { readonly desde: Date; readonly hasta: Date };
  readonly ejecucion: { readonly inicio: Date | null; readonly cierre: Date | null };
  readonly estado: string;
  readonly compliance: ComplianceResult;
  readonly umbral: number;
  readonly puntos: readonly FilaPunto[];
  readonly omitidos: readonly FilaPunto[];
  readonly incidentes: readonly IncidenteInforme[];
  readonly anexo: readonly FotoAnexo[];
  /** false cuando el informe se genera liviano para adjuntarlo a un correo. */
  readonly incluyeAnexo: boolean;
}

export interface EntradaModelo {
  readonly ronda: EncabezadoRondaRow;
  readonly puntos: readonly PuntoEsperadoRow[];
  readonly scans: readonly ScanRow[];
  readonly fotos: readonly FotoRow[];
  readonly incidentes: readonly IncidenteRow[];
  readonly marca: MarcaDocumento;
  readonly umbral: number;
  readonly incluirAnexo?: boolean;
  /** Criticidades que se destacan visualmente; viene de las reglas del tenant. */
  readonly criticidadesDestacadas?: readonly string[];
}

/**
 * Arma el modelo del informe.
 *
 * El cumplimiento se toma de computeCompliance() de @voxia/shared y NO se
 * recalcula: la tabla marca omitido exactamente lo que la funcion del dominio
 * declaro faltante, asi el porcentaje del encabezado nunca puede contradecir a
 * las filas que estan abajo.
 */
export function construirInformeRonda(entrada: EntradaModelo): InformeRonda {
  const {
    ronda,
    puntos,
    scans,
    fotos,
    incidentes,
    marca,
    umbral,
    incluirAnexo = true,
    criticidadesDestacadas = ['alta', 'panico'],
  } = entrada;

  const compliance = computeCompliance(
    puntos.map((p) => p.id),
    scans.map((s) => ({ checkpointId: s.checkpoint_id, anomalies: s.anomalies ?? [] })),
    umbral,
  );
  const omitidos = new Set(compliance.missedCheckpointIds);

  // El guardia puede escanear un punto mas de una vez (reintento, sincronizacion
  // repetida). El informe muestra la PRIMERA lectura: es la hora en que estuvo
  // realmente ahi.
  const primeraLectura = new Map<string, ScanRow>();
  for (const scan of [...scans].sort(comparaPorHoraServidor)) {
    if (!primeraLectura.has(scan.checkpoint_id)) primeraLectura.set(scan.checkpoint_id, scan);
  }

  const filas: FilaPunto[] = puntos.map((punto, indice) => {
    const lectura = primeraLectura.get(punto.id);
    return {
      numero: indice + 1,
      checkpointId: punto.id,
      nombre: punto.name,
      esCierre: punto.is_closing_point === true,
      esCritico: punto.kind === 'acceso_critico',
      omitido: omitidos.has(punto.id),
      escaneadoEn: lectura ? lectura.scanned_at_server : null,
      metodo: lectura ? lectura.method : null,
      anomalias: lectura?.anomalies ?? [],
    };
  });

  const numeroPorPunto = new Map(filas.map((fila) => [fila.checkpointId, fila.numero]));

  return {
    patrolId: ronda.id,
    filename: `informe-ronda-${ronda.id}.pdf`,
    marca,
    timezone: ronda.timezone,
    recinto: {
      nombre: ronda.site_name,
      sucursal: ronda.branch_name,
      ruta: ronda.route_name,
      guardia: ronda.guard_name,
    },
    ventana: { desde: ronda.scheduled_start_at, hasta: ronda.scheduled_end_at },
    ejecucion: { inicio: ronda.started_at, cierre: ronda.closed_at },
    estado: ronda.status,
    compliance,
    umbral,
    puntos: filas,
    omitidos: filas.filter((fila) => fila.omitido),
    incidentes: incidentes.map((incidente) => ({
      id: incidente.id,
      criticidad: incidente.criticality,
      // El panico se dispara sin escribir nada: el boton es un solo toque.
      texto: incidente.text?.trim() || 'Sin descripción',
      reportadoEn: incidente.reported_at_server,
      destacado: criticidadesDestacadas.includes(incidente.criticality),
    })),
    anexo: incluirAnexo ? fotos.map((foto) => armarFoto(foto, numeroPorPunto)) : [],
    incluyeAnexo: incluirAnexo,
  };
}

function armarFoto(foto: FotoRow, numeroPorPunto: ReadonlyMap<string, number>): FotoAnexo {
  return {
    id: foto.id,
    checkpointId: foto.checkpoint_id,
    checkpointName: foto.checkpoint_name,
    // Una foto de un punto que no esta en el orden esperado igual va al anexo:
    // es evidencia tomada en terreno y perderla seria peor que no numerarla.
    numeroPunto: numeroPorPunto.get(foto.checkpoint_id) ?? null,
    storagePath: foto.storage_path,
    mimeType: foto.mime_type,
    // bigint llega como string desde el driver de postgres.
    sizeBytes: Number(foto.size_bytes),
    huella: foto.sha256.slice(0, 12),
    capturadaEn: foto.taken_at_device ?? foto.created_at,
  };
}

function comparaPorHoraServidor(a: ScanRow, b: ScanRow): number {
  return new Date(a.scanned_at_server).getTime() - new Date(b.scanned_at_server).getTime();
}

/** "fuera_de_radio_gps" -> "fuera de radio gps" */
export function etiquetaAnomalia(anomalia: ScanAnomaly): string {
  return anomalia.replaceAll('_', ' ');
}

export const CRITICIDADES: Record<string, string> = {
  info: 'Informativo',
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
  panico: 'PÁNICO',
};
