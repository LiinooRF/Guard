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

/**
 * Una tarea del turno con su respuesta, si la hubo (#265).
 *
 * Es un LEFT JOIN de checklist_items contra checklist_responses: la tarea que
 * NO se hizo —el caso que mas importa en un informe— no tiene fila en
 * responses, asi que todo lo que viene de la respuesta es anulable.
 *
 * `due_local_time` es `time` en PostgreSQL y el driver lo entrega como STRING
 * ('11:00:00'), nunca como Date. Pasarlo por formatearFechaHora daria
 * `new Date('11:00:00')` -> invalido -> '—', y el informe perderia justo la
 * hora que el producto pidio mostrar.
 */
export interface TareaRow {
  item_id: string;
  position: number | string;
  label: string;
  response_type: string;
  requires_photo: boolean;
  requires_photo_on_fail: boolean;
  due_local_time: string | null;
  checkpoint_id: string | null;
  checkpoint_name: string | null;
  response_id: string | null;
  value: string | null;
  notes: string | null;
  failed: boolean | null;
  photo_id: string | null;
  late_minutes: number | string | null;
  responded_at: Date | null;
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
  /**
   * Tarea del turno que pidio esta foto, o null si es evidencia de escaneo.
   * Sin esto, la foto del refrigerador queda en el anexo rotulada solo con el
   * punto y nadie sabe que era la tarea de las 11.
   */
  readonly tarea: string | null;
}

export interface IncidenteInforme {
  readonly id: string;
  readonly criticidad: string;
  readonly texto: string;
  readonly reportadoEn: Date;
  readonly destacado: boolean;
}

/** 'pendiente' = la tarea nunca se respondio; es un estado, no un vacio. */
export type EstadoTarea = 'cumplida' | 'falla' | 'pendiente';

export interface TareaInforme {
  readonly itemId: string;
  readonly etiqueta: string;
  /** Numero del punto en la ronda; null si la tarea es general del turno. */
  readonly numeroPunto: number | null;
  /** Nombre del punto donde toca hacerla; null = en cualquier parte del recinto. */
  readonly punto: string | null;
  /** "11:00" en la zona DEL RECINTO. null = a cualquier hora de la ronda. */
  readonly horaPedida: string | null;
  readonly estado: EstadoTarea;
  readonly respuesta: string | null;
  readonly observacion: string | null;
  readonly respondidaEn: Date | null;
  /** Si esta respuesta tenia que traer foto (por la tarea o por ser falla). */
  readonly exigeFoto: boolean;
  readonly fotoId: string | null;
  /** Respondida, exigia foto y no la tiene: estado propio, se imprime. */
  readonly faltaFoto: boolean;
  /**
   * Minutos de atraso TAL COMO los guardo quien registro la respuesta. No se
   * recalcula aca —igual que `omitido` sale de computeCompliance— porque un
   * recalculo con otra zona horaria daria una cifra distinta a la que ya vio el
   * guardia, y el informe contradiria al sistema.
   */
  readonly atrasoMinutos: number | null;
  readonly atrasada: boolean;
}

export interface ResumenTareas {
  readonly total: number;
  readonly cumplidas: number;
  readonly fallidas: number;
  readonly pendientes: number;
  readonly atrasadas: number;
  readonly sinFoto: number;
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
  /**
   * Tareas del turno con su respuesta. Vacio cuando la ronda no tiene checklist
   * —que es el 100% de las rondas de antes de #265— y ahi el informe sale
   * exactamente igual que siempre.
   *
   * NO entran al porcentaje de cumplimiento: ese numero es sobre puntos
   * escaneados, y mezclarlo dejaria de cuadrar con la tabla que va debajo.
   */
  readonly tareas: readonly TareaInforme[];
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
  /** Opcional: una ronda sin checklist no manda esta lista y no cambia en nada. */
  readonly tareas?: readonly TareaRow[];
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
    tareas = [],
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

  // El orden de las tareas lo decide la consulta (hora pedida, despues posicion
  // en la plantilla) y aca se respeta: reordenar seria una segunda verdad.
  const tareasInforme = tareas.map((tarea) => armarTarea(tarea, numeroPorPunto));
  const tareaPorFoto = new Map<string, string>();
  for (const tarea of tareasInforme) {
    if (tarea.fotoId !== null) tareaPorFoto.set(tarea.fotoId, tarea.etiqueta);
  }

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
    tareas: tareasInforme,
    incidentes: incidentes.map((incidente) => ({
      id: incidente.id,
      criticidad: incidente.criticality,
      // El panico se dispara sin escribir nada: el boton es un solo toque.
      texto: incidente.text?.trim() || 'Sin descripción',
      reportadoEn: incidente.reported_at_server,
      destacado: criticidadesDestacadas.includes(incidente.criticality),
    })),
    anexo: incluirAnexo
      ? fotos.map((foto) => armarFoto(foto, numeroPorPunto, tareaPorFoto))
      : [],
    incluyeAnexo: incluirAnexo,
  };
}

function armarFoto(
  foto: FotoRow,
  numeroPorPunto: ReadonlyMap<string, number>,
  tareaPorFoto: ReadonlyMap<string, string>,
): FotoAnexo {
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
    tarea: tareaPorFoto.get(foto.id) ?? null,
  };
}

function armarTarea(
  tarea: TareaRow,
  numeroPorPunto: ReadonlyMap<string, number>,
): TareaInforme {
  const respondida = tarea.response_id !== null && tarea.response_id !== undefined;
  const fallo = respondida && tarea.failed === true;
  const fotoId = tarea.photo_id ?? null;
  // La foto la puede exigir la tarea (requires_photo, "fotografia el
  // refrigerador") o la falla (requires_photo_on_fail, el caso de #129). Las dos
  // terminan en lo mismo: una respuesta que tenia que traer evidencia.
  const exigeFoto =
    respondida &&
    (tarea.requires_photo === true || (fallo && tarea.requires_photo_on_fail === true));
  const atrasoMinutos = aMinutos(tarea.late_minutes);

  return {
    itemId: tarea.item_id,
    etiqueta: tarea.label,
    numeroPunto: tarea.checkpoint_id ? (numeroPorPunto.get(tarea.checkpoint_id) ?? null) : null,
    punto: tarea.checkpoint_name ?? null,
    horaPedida: horaLocal(tarea.due_local_time),
    estado: !respondida ? 'pendiente' : fallo ? 'falla' : 'cumplida',
    respuesta: respondida ? tarea.value : null,
    observacion: tarea.notes?.trim() || null,
    respondidaEn: tarea.responded_at ?? null,
    exigeFoto,
    fotoId,
    // Solo tiene sentido en lo ya respondido: en una tarea pendiente lo que
    // falta es la tarea entera, y marcarle ademas "sin foto" es ruido.
    faltaFoto: exigeFoto && fotoId === null,
    atrasoMinutos,
    atrasada: atrasoMinutos !== null && atrasoMinutos > 0,
  };
}

/**
 * `time` de PostgreSQL -> "HH:MM".
 *
 * El driver entrega '11:00:00' (o '11:00:00.123456'), un STRING. Si esto no
 * existiera, el renderer haria new Date('11:00:00') -> Invalid Date -> '—', y
 * ningun mock lo delataria porque el mock devuelve lo que el autor escribio.
 * Un formato inesperado se devuelve tal cual: perder el dato es peor que
 * mostrarlo raro.
 */
function horaLocal(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (texto === '') return null;
  const partes = /^(\d{1,2}):(\d{2})/.exec(texto);
  return partes ? `${partes[1]!.padStart(2, '0')}:${partes[2]}` : texto;
}

/** integer anulable del driver; se acepta string por si viaja serializado. */
function aMinutos(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

/**
 * Los contadores que el informe (y el correo) mencionan sin repetir la cuenta
 * en cada superficie. Es una funcion y no un campo del modelo para no obligar a
 * cada llamador que arma un InformeRonda a mano a mantener el numero al dia.
 */
export function resumirTareas(tareas: readonly TareaInforme[]): ResumenTareas {
  return {
    total: tareas.length,
    cumplidas: tareas.filter((t) => t.estado === 'cumplida').length,
    fallidas: tareas.filter((t) => t.estado === 'falla').length,
    pendientes: tareas.filter((t) => t.estado === 'pendiente').length,
    atrasadas: tareas.filter((t) => t.atrasada).length,
    sinFoto: tareas.filter((t) => t.faltaFoto).length,
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
