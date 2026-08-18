import { computeCompliance, type ComplianceResult, type ScanAnomaly } from '@sentrycore/shared';

import { desvioDeTurno, type DesvioDeTurno } from './desvio-de-turno';
import type { MarcaDocumento } from './pdf-primitivas';
import type { MapaRecorrido } from './mapa-recorrido.model';

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
  /**
   * `checkpoints.instructions`: que tiene que revisar el guardia ahi. La columna
   * existe desde la migracion inicial, pero el informe no la consultaba: es la
   * linea "Instrucciones:" de la bitacora (#308).
   */
  instructions?: string | null;
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
  /**
   * `scan_photos.scan_id`, que es NOT NULL: no existe la foto huerfana de
   * escaneo. Se trae para poder agrupar la evidencia de una misma lectura y
   * para que la numeracion no dependa de `created_at`, que es la hora de SUBIDA
   * y con la cola offline cambia entre una ronda y la misma ronda resincronizada.
   */
  scan_id: string;
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
  /** Que hay que revisar en ese punto; null cuando el recinto no lo cargo (#308). */
  readonly instrucciones: string | null;
}

export interface FotoAnexo {
  readonly id: string;
  /** Escaneo del que cuelga. NOT NULL en la base: no hay foto sin escaneo. */
  readonly scanId: string;
  readonly checkpointId: string;
  readonly checkpointName: string;
  /** Numero del punto en la ronda, o null si la foto no corresponde a uno esperado. */
  readonly numeroPunto: number | null;
  /**
   * Correlativo del informe, 1..N. Es el mismo numero en la bitacora y en el
   * anexo para que "la foto 12" signifique lo mismo en las dos secciones.
   */
  readonly numero: number;
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
  /** Id de la respuesta de checklist que la reclamo; null si es de escaneo. */
  readonly tareaId: string | null;
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
  /**
   * Minutos entre inicio y cierre; null si falta alguno de los dos. Es una resta
   * derivada y no una columna: `patrols` no guarda duracion, y calcularla aca
   * evita que el informe invente un valor cuando la ronda no cerro.
   */
  readonly duracionMin: number | null;
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
  /**
   * TODA la evidencia de la ronda, con o sin anexo.
   *
   * El interruptor del anexo gobierna los BYTES de las imagenes, no el HECHO de
   * que existan: el informe que se adjunta al correo va liviano, pero tiene que
   * poder decir "18 fotografias registradas, disponibles en el panel". Antes de
   * #308 esa lista ni siquiera se consultaba y quien recibia el correo no podia
   * saber que habia evidencia esperandolo.
   */
  readonly evidencias: readonly FotoAnexo[];
  /** Lo que se dibuja en el anexo: `evidencias` si va con anexo, vacio si no. */
  readonly anexo: readonly FotoAnexo[];
  /** false cuando el informe se genera liviano para adjuntarlo a un correo. */
  readonly incluyeAnexo: boolean;
  /**
   * El recorrido dibujado (#79). `null` cuando el tenant apago `reportIncludeMap`
   * o cuando el informe se arma sin mapa (el liviano del correo). Un mapa con
   * `hayDatos` en false NO es lo mismo: ese se dibuja igual, para explicarle al
   * lector por que no se pudo trazar.
   */
  readonly mapa: MapaRecorrido | null;
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
  /** El recorrido ya construido, o null si esta seccion no va (#79). */
  readonly mapa?: MapaRecorrido | null;
  /** Criticidades que se destacan visualmente; viene de las reglas del tenant. */
  readonly criticidadesDestacadas?: readonly string[];
}

/**
 * Arma el modelo del informe.
 *
 * El cumplimiento se toma de computeCompliance() de @sentrycore/shared y NO se
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
      instrucciones: punto.instructions?.trim() || null,
    };
  });

  const numeroPorPunto = new Map(filas.map((fila) => [fila.checkpointId, fila.numero]));

  // El orden de las tareas lo decide la consulta (hora pedida, despues posicion
  // en la plantilla) y aca se respeta: reordenar seria una segunda verdad.
  const tareasInforme = tareas.map((tarea) => armarTarea(tarea, numeroPorPunto));
  const tareaPorFoto = new Map<string, TareaInforme>();
  for (const tarea of tareasInforme) {
    if (tarea.fotoId !== null) tareaPorFoto.set(tarea.fotoId, tarea);
  }

  const evidencias = numerarEvidencias(fotos, numeroPorPunto, tareaPorFoto);

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
    duracionMin: minutosEntre(ronda.started_at, ronda.closed_at),
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
    evidencias,
    anexo: incluirAnexo ? evidencias : [],
    incluyeAnexo: incluirAnexo,
    mapa: entrada.mapa ?? null,
  };
}

/**
 * Ordena la evidencia y le pone su correlativo 1..N.
 *
 * El orden es por punto de la ronda y NO por `created_at`. `created_at` es la
 * hora en que la foto se subio: con la cola offline, la misma ronda subida en
 * vivo y resincronizada tres horas despues produce dos ordenes distintos, y por
 * lo tanto dos numeraciones distintas para las mismas fotos. Con el punto como
 * clave, "la foto 12" significa lo mismo aunque el telefono suba en otro orden.
 *
 * Las que no pertenecen a un punto esperado van al final (9999) en vez de
 * descartarse: son evidencia tomada en terreno y perderlas es peor que no
 * poder numerarlas por su posicion en la ruta.
 */
function numerarEvidencias(
  fotos: readonly FotoRow[],
  numeroPorPunto: ReadonlyMap<string, number>,
  tareaPorFoto: ReadonlyMap<string, TareaInforme>,
): readonly FotoAnexo[] {
  return [...fotos]
    .map((foto) => {
      const tarea = tareaPorFoto.get(foto.id) ?? null;
      return {
        id: foto.id,
        scanId: foto.scan_id,
        checkpointId: foto.checkpoint_id,
        checkpointName: foto.checkpoint_name,
        numeroPunto: numeroPorPunto.get(foto.checkpoint_id) ?? null,
        // Se sobreescribe abajo, cuando el orden ya esta decidido.
        numero: 0,
        storagePath: foto.storage_path,
        mimeType: foto.mime_type,
        // bigint llega como string desde el driver de postgres.
        sizeBytes: Number(foto.size_bytes),
        huella: foto.sha256.slice(0, 12),
        capturadaEn: foto.taken_at_device ?? foto.created_at,
        tarea: tarea?.etiqueta ?? null,
        tareaId: tarea?.itemId ?? null,
      };
    })
    .sort(compararEvidencias)
    .map((foto, indice) => ({ ...foto, numero: indice + 1 }));
}

function compararEvidencias(a: FotoAnexo, b: FotoAnexo): number {
  const puntoA = a.numeroPunto ?? 9999;
  const puntoB = b.numeroPunto ?? 9999;
  if (puntoA !== puntoB) return puntoA - puntoB;
  // Dentro del mismo punto, la evidencia de una misma lectura queda junta.
  if (a.scanId !== b.scanId) return a.scanId < b.scanId ? -1 : 1;
  const horaA = a.capturadaEn.getTime();
  const horaB = b.capturadaEn.getTime();
  if (horaA !== horaB) return horaA - horaB;
  // El id cierra el desempate: dos corridas del mismo informe salen iguales.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Minutos entre dos instantes, redondeados. null si falta alguno o no son fechas. */
function minutosEntre(inicio: Date | null, fin: Date | null): number | null {
  if (inicio === null || fin === null) return null;
  const desde = new Date(inicio).getTime();
  const hasta = new Date(fin).getTime();
  if (Number.isNaN(desde) || Number.isNaN(hasta)) return null;
  return Math.max(0, Math.round((hasta - desde) / 60_000));
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

// ------------------------------------------------------- bitacora cronologica

export type TipoEntrada = 'inicio' | 'escaneo' | 'tarea' | 'incidente' | 'cierre';

export interface EntradaBitacora {
  readonly tipo: TipoEntrada;
  /** Siempre hora de SERVIDOR. Ver la nota de orden en construirBitacora. */
  readonly instante: Date;
  /** Identidad estable de la entrada; tambien es el ultimo desempate del orden. */
  readonly clave: string;
  readonly punto: FilaPunto | null;
  readonly tarea: TareaInforme | null;
  readonly incidente: IncidenteInforme | null;
  /** Evidencia que cuelga de esta entrada, ya numerada. */
  readonly fotos: readonly FotoAnexo[];
}

export interface Bitacora {
  readonly entradas: readonly EntradaBitacora[];
  /** Entradas que no se dibujaron por el tope del tenant. 0 = salieron todas. */
  readonly omitidasPorTope: number;
  /**
   * La evidencia que colgaba de las entradas recortadas por el tope.
   *
   * Existe porque recortar la cronologia NO puede recortar la evidencia: con la
   * bitacora encendida el anexo 2x2 ya no se dibuja, asi que una foto que se
   * quedaba fuera de la entrada se quedaba fuera del DOCUMENTO ENTERO, y el
   * unico aviso hablaba de "anotaciones omitidas" sin nombrar las fotos. En un
   * producto cuyo sentido es demostrar que alguien estuvo en un lugar, perder
   * evidencia en silencio es lo peor que puede pasar. El renderer las manda al
   * anexo; aca solo se separan para que no haya forma de olvidarlas.
   */
  readonly fotosRecortadas: readonly FotoAnexo[];
  /** Sin hora: nunca ocurrieron, asi que no pueden estar en una cronologia. */
  readonly tareasSinResponder: readonly TareaInforme[];
  /** Fotos de puntos que no estaban en la ruta. Se conservan, no se descartan. */
  readonly evidenciaSinPunto: readonly FotoAnexo[];
}

/** Orden de los tipos cuando dos entradas caen en el mismo instante. */
const RANGO_TIPO: Record<TipoEntrada, number> = {
  inicio: 0,
  escaneo: 1,
  tarea: 2,
  incidente: 3,
  cierre: 4,
};

export interface OpcionesBitacora {
  /** Tope de entradas dibujadas; viene de reportTimelineMaxEntries. */
  readonly maxEntradas?: number;
}

/**
 * La ronda contada como una cronologia: cada marca, cada respuesta del checklist
 * y cada novedad en el orden en que ocurrieron (#308).
 *
 * ---------------------------------------------------------------------------
 * EL CRITERIO DE ORDEN, QUE ES LO UNICO DELICADO DE ESTA FUNCION
 * ---------------------------------------------------------------------------
 * Los cinco tipos se ordenan por reloj de SERVIDOR y nunca por reloj de
 * telefono. `capturadaEn` de una foto es `taken_at_device ?? created_at`: el
 * primero es el reloj del guardia —el producto tiene un modulo entero de
 * desfase de reloj— y el segundo es la hora de SUBIDA, que con la cola offline
 * puede ser horas despues de la ronda. Ordenar la bitacora con esa hora produce
 * una cronologia que se reordena sola segun la señal que tuvo el telefono. La
 * hora del telefono se MUESTRA; no se usa para ordenar.
 *
 * Por eso la foto tampoco se ubica por su hora: cuelga de su escaneo (por el
 * punto) o de la tarea que la reclamo (por `photo_id`), que es una relacion de
 * la base y no una aproximacion.
 *
 * El desempate es determinista a proposito —tipo, numero de punto, orden de
 * origen, clave— para que la misma ronda renderice identica dos veces. Sin eso,
 * comparar dos PDF de la misma ronda no significa nada.
 *
 * Esta funcion NO reclasifica ni recuenta: `omitido` ya lo decidio
 * computeCompliance y el atraso ya lo guardo el servidor. Si la bitacora
 * contara sus propios omitidos, tarde o temprano diria algo distinto de la
 * tabla de la pagina anterior sobre la misma ronda.
 */
export function construirBitacora(
  informe: InformeRonda,
  opciones: OpcionesBitacora = {},
): Bitacora {
  const { maxEntradas } = opciones;

  // La evidencia se reparte ANTES de armar las entradas: cada foto tiene un solo
  // dueño y el que sobra queda explicitamente en `evidenciaSinPunto`.
  const porTarea = new Map<string, FotoAnexo[]>();
  const porPunto = new Map<string, FotoAnexo[]>();
  const sinPunto: FotoAnexo[] = [];

  const puntoEscaneado = new Map(
    informe.puntos.filter((p) => p.escaneadoEn !== null).map((p) => [p.checkpointId, p]),
  );
  const tareaRespondida = new Map(
    informe.tareas.filter((t) => t.respondidaEn !== null).map((t) => [t.itemId, t]),
  );

  for (const foto of informe.evidencias) {
    if (foto.tareaId !== null && tareaRespondida.has(foto.tareaId)) {
      empujar(porTarea, foto.tareaId, foto);
    } else if (puntoEscaneado.has(foto.checkpointId)) {
      empujar(porPunto, foto.checkpointId, foto);
    } else {
      // Punto fuera de la ruta, o punto de la ruta cuyo escaneo no llego: la
      // foto existe igual y se conserva rotulada al final de la bitacora.
      sinPunto.push(foto);
    }
  }

  const crudas: Array<{ entrada: EntradaBitacora; origen: number; punto: number }> = [];
  let origen = 0;
  const agregar = (
    entrada: Omit<EntradaBitacora, 'fotos'> & { fotos?: readonly FotoAnexo[] },
    numeroPunto: number | null,
  ) => {
    crudas.push({
      entrada: { ...entrada, fotos: entrada.fotos ?? [] },
      origen: origen++,
      punto: numeroPunto ?? 9999,
    });
  };

  if (informe.ejecucion.inicio !== null) {
    agregar(
      {
        tipo: 'inicio',
        instante: informe.ejecucion.inicio,
        clave: 'inicio',
        punto: null,
        tarea: null,
        incidente: null,
      },
      null,
    );
  }

  for (const punto of informe.puntos) {
    if (punto.escaneadoEn === null) continue;
    agregar(
      {
        tipo: 'escaneo',
        instante: punto.escaneadoEn,
        clave: `escaneo:${punto.checkpointId}`,
        punto,
        tarea: null,
        incidente: null,
        fotos: porPunto.get(punto.checkpointId) ?? [],
      },
      punto.numero,
    );
  }

  for (const tarea of informe.tareas) {
    if (tarea.respondidaEn === null) continue;
    agregar(
      {
        tipo: 'tarea',
        instante: tarea.respondidaEn,
        clave: `tarea:${tarea.itemId}`,
        punto: null,
        tarea,
        incidente: null,
        fotos: porTarea.get(tarea.itemId) ?? [],
      },
      tarea.numeroPunto,
    );
  }

  for (const incidente of informe.incidentes) {
    agregar(
      {
        tipo: 'incidente',
        instante: incidente.reportadoEn,
        clave: `novedad:${incidente.id}`,
        punto: null,
        tarea: null,
        incidente,
      },
      null,
    );
  }

  if (informe.ejecucion.cierre !== null) {
    agregar(
      {
        tipo: 'cierre',
        instante: informe.ejecucion.cierre,
        clave: 'cierre',
        punto: null,
        tarea: null,
        incidente: null,
      },
      null,
    );
  }

  const ordenadas = crudas
    .filter((c) => !Number.isNaN(new Date(c.entrada.instante).getTime()))
    .sort((a, b) => {
      const ta = new Date(a.entrada.instante).getTime();
      const tb = new Date(b.entrada.instante).getTime();
      if (ta !== tb) return ta - tb;
      const rango = RANGO_TIPO[a.entrada.tipo] - RANGO_TIPO[b.entrada.tipo];
      if (rango !== 0) return rango;
      if (a.punto !== b.punto) return a.punto - b.punto;
      if (a.origen !== b.origen) return a.origen - b.origen;
      return a.entrada.clave < b.entrada.clave ? -1 : 1;
    })
    .map((c) => c.entrada);

  const tope = maxEntradas !== undefined && maxEntradas > 0 ? maxEntradas : ordenadas.length;
  const recortadas = ordenadas.slice(tope);

  return {
    entradas: ordenadas.slice(0, tope),
    omitidasPorTope: recortadas.length,
    fotosRecortadas: recortadas.flatMap((entrada) => entrada.fotos),
    // Ordenadas por hora pedida, con las sin hora al final: es como las lee un
    // supervisor que revisa que quedo sin hacer.
    tareasSinResponder: informe.tareas
      .filter((t) => t.estado === 'pendiente')
      .map((tarea, indice) => ({ tarea, indice }))
      .sort((a, b) => {
        const ha = a.tarea.horaPedida ?? '99:99';
        const hb = b.tarea.horaPedida ?? '99:99';
        if (ha !== hb) return ha < hb ? -1 : 1;
        return a.indice - b.indice;
      })
      .map((c) => c.tarea),
    evidenciaSinPunto: sinPunto,
  };
}

function empujar<T>(mapa: Map<string, T[]>, clave: string, valor: T): void {
  const lista = mapa.get(clave);
  if (lista) lista.push(valor);
  else mapa.set(clave, [valor]);
}

/**
 * "Motivo de ronda incompleta", derivado y nunca escrito a mano.
 *
 * El informe de la competencia trae un campo de texto libre que alguien llena.
 * Aca no existe esa columna en `patrols` y agregarla seria pedirle al guardia
 * que justifique por escrito lo que el sistema ya sabe. Derivarlo tiene ademas
 * la ventaja de que no se puede falsear.
 *
 * ---------------------------------------------------------------------------
 * QUE HACE INCOMPLETA A UNA RONDA — decision de producto, no criterio del que
 * dibuja: SOLO los puntos omitidos y la falta de cierre.
 * ---------------------------------------------------------------------------
 * Antes tambien sumaban las anomalias, el desvio de turno y el checklist, y eso
 * ponia el recuadro rojo de "ronda incompleta" en rondas de 40/40 con 100% de
 * cumplimiento y 0 omitidos: el informe se contradecia a si mismo contra sus
 * propias cifras de la misma pagina. Peor todavia, la consulta de tareas cae en
 * la plantilla vigente cuando la ronda no respondio ninguna, asi que TODA ronda
 * anterior al checklist heredaba "tareas pendientes" y salia marcada incompleta
 * sin serlo.
 *
 * Lo demas informa y por eso existe `redactarObservaciones`, que va en su propio
 * bloque: una marca de anomalia importa —es el nucleo antifraude— pero no
 * convierte en incompleta una ronda que se recorrio entera.
 *
 * Devuelve la lista vacia cuando no hay nada que explicar: una ronda perfecta
 * no recibe un recuadro vacio.
 */
export function redactarMotivoIncompleta(informe: InformeRonda): string[] {
  // Sin inicio no paso nada mas que reportar, y enumerar los 9 puntos omitidos
  // de una ronda que nunca arranco es ruido que tapa el unico dato que importa.
  if (informe.ejecucion.inicio === null) return ['Ronda no iniciada'];

  const motivos: string[] = [];
  const { omitidos, puntos, compliance } = informe;

  if (omitidos.length > 0) {
    motivos.push(
      `${omitidos.length} punto(s) sin escanear de ${compliance.expected}: ${listar(
        omitidos.map((p) => p.nombre),
      )}`,
    );
  }

  // Explica por que la ronda no se cerro sola: el cierre lo dispara el ultimo
  // punto, y si ese punto no se marco el sistema no tenia como saber que termino.
  if (puntos.some((p) => p.esCierre && p.omitido)) {
    motivos.push('El punto de cierre no se escaneó');
  }

  if (informe.ejecucion.cierre === null) motivos.push('Ronda sin cierre registrado');

  return motivos;
}

/**
 * Lo que hay que decir de la ronda sin declararla incompleta.
 *
 * Anomalias, desvio de turno y checklist: informan, y ninguna significa que
 * falte un punto. Van en un bloque aparte titulado "Observaciones" para que el
 * recuadro rojo siga queriendo decir una sola cosa.
 *
 * Vacio = no hay nada que observar, y entonces no se dibuja el bloque.
 */
export function redactarObservaciones(informe: InformeRonda): string[] {
  // Una ronda que no arranco ya lo dice todo en el motivo; enumerarle
  // observaciones de algo que nunca ocurrio es inventar.
  if (informe.ejecucion.inicio === null) return [];

  const observaciones: string[] = [];
  const { puntos, tareas } = informe;

  const conMarcas = puntos.filter((p) => !p.omitido && p.anomalias.length > 0);
  if (conMarcas.length > 0) {
    const tipos = [...new Set(conMarcas.flatMap((p) => p.anomalias))].map(etiquetaAnomalia);
    observaciones.push(`${conMarcas.length} punto(s) con marcas de anomalía: ${listar(tipos)}`);
  }

  const desvios = puntos
    .map((p) => desvioDeTurno(p.escaneadoEn, informe.ventana))
    .filter((d): d is DesvioDeTurno => d !== null);
  if (desvios.length > 0) {
    const peor = desvios.reduce((a, b) => (b.minutos > a.minutos ? b : a));
    observaciones.push(`${desvios.length} marca(s) fuera del turno; la mayor, ${peor.texto}`);
  }

  // Del checklist solo se habla cuando CONSTA que esta ronda lo tuvo. Ver
  // `checklistConsta`: sin esa condicion, el 100% del historico anterior al
  // checklist recibiria observaciones sobre tareas que nunca existieron.
  if (checklistConsta(tareas)) {
    const resumen = resumirTareas(tareas);
    if (resumen.pendientes > 0) {
      observaciones.push(`${resumen.pendientes} tarea(s) sin responder`);
    }
    if (resumen.fallidas > 0) observaciones.push(`${resumen.fallidas} tarea(s) con falla`);
    if (resumen.sinFoto > 0) observaciones.push(`${resumen.sinFoto} tarea(s) sin la foto exigida`);
  }

  return observaciones;
}

/**
 * Si esta ronda tuvo checklist DE VERDAD, y no una plantilla deducida.
 *
 * La consulta de tareas (`SQL_TAREAS_DEL_TURNO`) resuelve la plantilla por los
 * items ya respondidos, y solo cae en la plantilla vigente hoy cuando la ronda
 * no respondio ninguno. En ese caso la lista es una suposicion razonable para
 * mostrarla rotulada, pero NO es un hecho de la ronda: una ronda de 2025 resuelve
 * hoy a una plantilla creada en 2026. Una respuesta —una sola— es lo que
 * convierte esa lista en algo que consta que el guardia vio.
 */
function checklistConsta(tareas: readonly TareaInforme[]): boolean {
  return tareas.some((tarea) => tarea.estado !== 'pendiente');
}

/** "A, B y 3 más": la lista completa de 40 nombres no cabe ni se lee. */
function listar(nombres: readonly string[], tope = 3): string {
  if (nombres.length <= tope) return nombres.join(', ');
  return `${nombres.slice(0, tope).join(', ')} y ${nombres.length - tope} más`;
}
