import PDFDocument from 'pdfkit';

import { desvioDeTurno, redactarAtrasoDeTarea, redactarDuracion } from './desvio-de-turno';
import {
  MOTIVO_TEXTO,
  leerEvidencia,
  leerLogoMarca,
  type MotivoEvidencia,
} from './evidence-reader';
import {
  CRITICIDADES,
  construirBitacora,
  etiquetaAnomalia,
  redactarMotivoIncompleta,
  resumirTareas,
  type Bitacora,
  type EntradaBitacora,
  type EstadoTarea,
  type FotoAnexo,
  type InformeRonda,
} from './patrol-report.model';
import {
  ALTO_PIE,
  ESTADOS_RONDA,
  MARGEN,
  PALETA,
  anchoUtil,
  asegurarEspacioConPie,
  celdaAnexo,
  dibujarBarra,
  dibujarEncabezadoMarca,
  dibujarFicha,
  dibujarFilaBitacora,
  dibujarFranjaMarca,
  dibujarIndicadores,
  dibujarLineaDeTiempo,
  dibujarPie,
  dibujarSeparadorDia,
  dibujarTabla,
  dibujarTituloSeccion,
  formatearFecha,
  formatearFechaHora,
  formatearHora,
  limiteInferior,
  recortar,
  type Celda,
  type CeldaAnexo,
  type GeometriaAnexo,
  type HitoLinea,
  type Indicador,
  type LineaBitacora,
} from './pdf-primitivas';

/**
 * Dibujo del informe de ronda en PDF (#85, rediseñado como bitacora en #308).
 *
 * ---------------------------------------------------------------------------
 * DECISION DE MEMORIA — por que streaming y no un Buffer
 * ---------------------------------------------------------------------------
 * Una ronda de 40 puntos con foto en cada uno son ~120 MB de JPEG. Armar eso en
 * un Buffer y despues responderlo son dos copias completas en el heap, y basta
 * con tres descargas simultaneas para tumbar el proceso de la API.
 *
 * pdfkit genera en streaming: escribe cada objeto al stream de salida a medida
 * que lo produce, sin retener las paginas ya cerradas (`bufferPages` queda en
 * false). Con `doc.pipe(respuesta)` los bytes salen hacia el cliente mientras
 * se dibuja, y lo unico vivo es la pagina en curso.
 *
 * Las fotos se recorren de a una: se lee UNA imagen del disco, se embebe y se
 * suelta la referencia antes de leer la siguiente. El pico de memoria es una
 * foto, no el album, y no depende del largo de la ronda. Eso vale igual para
 * las fotos incrustadas en la bitacora que para las del anexo — por eso el
 * cuerpo del informe paso a ser ASINCRONO en #308: antes no tocaba el disco.
 *
 * Detalle nada obvio pero decisivo: a `doc.image()` se le pasa el BUFFER y no
 * la ruta. pdfkit cachea las imagenes en `_imageRegistry` cuando el origen es
 * un string, y esa cache retiene cada JPEG hasta `doc.end()` — justo el
 * consumo que este diseño existe para evitar. Con un Buffer no hay cache.
 * ---------------------------------------------------------------------------
 */

/** Cuadricula del anexo: 2x2 por hoja deja la foto grande y legible impresa. */
const COLUMNAS_ANEXO = 2;
const FILAS_ANEXO = 2;
const SEPARACION_ANEXO = 14;
const ALTO_LEYENDA = 34;

/** Caja de la foto incrustada en la bitacora, y el alto de su rotulo. */
const ANCHO_FOTO_LINEA = 190;
const ALTO_FOTO_LINEA = 130;
const ALTO_ROTULO_FOTO = 20;
/** Lo que consume una foto en linea, con su rotulo y el aire de abajo. */
const ALTO_BLOQUE_FOTO = ALTO_FOTO_LINEA + ALTO_ROTULO_FOTO + 6;

/**
 * Techo del buffer de salida antes de frenar el dibujo.
 *
 * pdfkit empuja al stream sin mirar backpressure: su `_write` hace `push()` y
 * descarta el `false` que devuelve. Con un destino lento —un cliente que
 * descarga por 3G, un volumen de red— lo ya generado se acumula en el buffer
 * interno del documento, y ahi se pierde todo lo ganado leyendo las fotos de a
 * una. Entre foto y foto se cede el event loop hasta que baja de este techo.
 */
const TECHO_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Cortafuegos del compas de espera. Si el consumidor dejo de leer del todo
 * —cliente colgado, disco lleno— se sigue igual en vez de quedarse esperando
 * para siempre: el stream terminara en error y eso si se propaga.
 */
const MAX_ESPERAS_DRENAJE = 2_000;

export interface OpcionesRender {
  /** Raiz del volumen de evidencia (EVIDENCE_PATH). */
  readonly raizEvidencia: string;
  /** Techo por archivo; se alimenta de photoMaxSizeMB de las reglas del tenant. */
  readonly maxBytesFoto: number;
  /** Aviso de evidencia que no se pudo incluir. Sin nombres ni ubicaciones. */
  readonly onEvidenciaFallida?: (fotoId: string, motivo: MotivoEvidencia) => void;
  /** reportTimeline: la ronda contada como cronologia. Apagada, vuelven las tablas. */
  readonly bitacora?: boolean;
  /** reportInlinePhotos: la evidencia se muestra donde ocurrio. */
  readonly fotosEnLinea?: boolean;
  /** reportConfidentialLabel: la palabra CONFIDENCIAL en la portada. */
  readonly etiquetaConfidencial?: boolean;
  /** reportTimelineMaxEntries: tope de entradas dibujadas en la bitacora. */
  readonly maxEntradasBitacora?: number;
}

export interface ResumenRender {
  readonly fotosIncluidas: number;
  readonly fotosOmitidas: number;
  readonly paginasAnexo: number;
}

const VACIO: ResumenRender = { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 };

/**
 * Dibuja el informe sobre `destino` (la respuesta HTTP, un archivo temporal, o
 * un PassThrough si el llamador necesita los bytes).
 *
 * Resuelve cuando el destino termino de escribir, no cuando termino de dibujar:
 * el llamador necesita saber que el PDF salio completo.
 */
export async function renderizarInformeRonda(
  modelo: InformeRonda,
  destino: NodeJS.WritableStream,
  opciones: OpcionesRender,
): Promise<ResumenRender> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGEN,
    info: {
      Title: `Informe de ronda ${modelo.patrolId}`,
      // El PDF tambien se identifica con la marca del cliente: los metadatos
      // los ve cualquiera que abra el archivo.
      Author: modelo.marca.displayName,
      Creator: modelo.marca.displayName,
    },
  });

  const terminado = esperarFin(doc, destino);
  doc.pipe(destino);
  instalarPieDePagina(doc, modelo.timezone, modelo.marca.mailFooter);

  let resumen: ResumenRender = VACIO;
  try {
    const logo = await leerLogoMarca(modelo.marca.logoUri ?? null, opciones.raizEvidencia, {
      maxBytes: opciones.maxBytesFoto,
    });
    const cuerpo = await dibujarCuerpo(doc, modelo, logo, opciones);
    const anexo = await dibujarAnexo(doc, modelo, opciones);
    resumen = {
      fotosIncluidas: cuerpo.fotosIncluidas + anexo.fotosIncluidas,
      fotosOmitidas: cuerpo.fotosOmitidas + anexo.fotosOmitidas,
      paginasAnexo: anexo.paginasAnexo,
    };
  } catch (error) {
    // Ya salieron bytes por el cable: no hay forma de convertir esto en un 500
    // en JSON. Se cierra el documento para no dejar la conexion colgada y se
    // propaga para que quede en el log del request.
    doc.end();
    await terminado.catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }

  doc.end();
  await terminado;
  return resumen;
}

/**
 * Deja el pie —fecha de generacion, linea legal del tenant y numero de pagina—
 * en TODAS las hojas.
 *
 * Antes de #308 se dibujaba UNA vez, al final del cuerpo: con una ronda de 40
 * puntos el cuerpo ya ocupaba varias hojas y la linea legal aparecia solo en la
 * ultima. Con una bitacora de 6 o 7 paginas eso se nota de inmediato.
 *
 * Se engancha a `pageAdded` en vez de recorrer las paginas al final porque
 * `bufferPages` esta en false a proposito y las hojas cerradas ya no existen.
 * La primera hoja la crea el constructor del documento —antes de que este
 * listener exista— asi que se pinta a mano.
 */
export function instalarPieDePagina(
  doc: PDFKit.PDFDocument,
  timezone: string,
  mailFooter: string | null,
): { readonly paginas: number } {
  const estado = { paginas: 0 };
  let pintando = false;

  const pintar = () => {
    // Cortafuegos: si alguna vez dibujar el pie provocara un salto de pagina, la
    // reentrada seria infinita y el proceso se comeria la memoria en silencio.
    if (pintando) return;
    pintando = true;
    estado.paginas += 1;
    try {
      dibujarPie(doc, timezone, mailFooter, estado.paginas);
    } finally {
      // El pie escribe con coordenadas absolutas y deja el cursor al fondo de la
      // hoja: sin esto, la primera seccion de cada pagina se dibujaria ahi.
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
      pintando = false;
    }
  };

  doc.on('pageAdded', pintar);
  pintar();
  return estado;
}

// ------------------------------------------------------------------- cuerpo

/**
 * El cuerpo del informe. Se exporta para poder probarlo sobre un documento
 * propio: el renderer no tenia un solo test antes de #308 porque el documento
 * se creaba aca adentro y no habia por donde mirarlo.
 */
export async function dibujarCuerpo(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  logo: Buffer | null,
  opciones: OpcionesRender,
): Promise<ResumenRender> {
  dibujarPortada(doc, modelo, logo, opciones);

  if (opciones.bitacora === false) {
    // Sin bitacora el informe vuelve a ser la pila de tablas de siempre. Es lo
    // que pidio la regla del tenant, no un camino muerto.
    dibujarTareas(doc, modelo);
    dibujarIncidentes(doc, modelo);
    return VACIO;
  }

  return dibujarBitacora(doc, modelo, opciones);
}

function dibujarPortada(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  logo: Buffer | null,
  opciones: OpcionesRender,
): void {
  const tz = modelo.timezone;
  dibujarEncabezadoMarca(doc, modelo.marca, 'Informe de ronda', logo);

  if (opciones.etiquetaConfidencial !== false) {
    // Junto al filete y NUNCA dentro de la franja de color: encima del color de
    // marca elegido por el admin no hay contraste garantizado. El cursor se
    // repone para que la portada quede identica con la etiqueta y sin ella.
    const yCursor = doc.y;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETA.gris)
      .text('CONFIDENCIAL', doc.page.margins.left, yCursor - 11, {
        width: anchoUtil(doc),
        align: 'right',
        lineBreak: false,
      });
    doc.y = yCursor;
    doc.x = doc.page.margins.left;
  }

  // Identificacion de la ronda: el nombre de la ruta es como la nombra quien la
  // encargo, y el recinto es donde ocurrio.
  doc.font('Helvetica-Bold').fontSize(13).fillColor(PALETA.tinta)
    .text(modelo.recinto.ruta, doc.page.margins.left, doc.y + 4, {
      width: anchoUtil(doc),
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
    .text(`${modelo.recinto.nombre} · ${modelo.recinto.sucursal}`, doc.page.margins.left, doc.y + 2, {
      width: anchoUtil(doc),
      lineBreak: false,
    });
  doc.y += 14;
  doc.x = doc.page.margins.left;

  // El recinto y la sucursal NO se repiten en la ficha: ya estan arriba, y la
  // ruta tampoco, por lo mismo.
  dibujarFicha(doc, [
    ['Guardia', modelo.recinto.guardia],
    [
      'Ventana horaria',
      `${formatearFechaHora(modelo.ventana.desde, tz)} — ${formatearFechaHora(modelo.ventana.hasta, tz)}`,
    ],
    ['Inicio', formatearFechaHora(modelo.ejecucion.inicio, tz)],
    ['Fin', formatearFechaHora(modelo.ejecucion.cierre, tz)],
    ['Duración', textoDuracion(modelo)],
    ['Estado', ESTADOS_RONDA[modelo.estado] ?? modelo.estado],
  ]);

  dibujarIndicadores(doc, indicadoresDe(modelo));

  if (!modelo.incluyeAnexo && modelo.evidencias.length > 0) {
    // Sin esta linea, quien recibe el informe por correo cree que la ronda no
    // tuvo fotos. El interruptor esconde los bytes, no el hecho.
    doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
      .text(
        `Este informe se emite sin imágenes (${modelo.evidencias.length} fotografía(s) registradas). ` +
          'La evidencia está disponible en el panel.',
        doc.page.margins.left,
        doc.y,
        { width: anchoUtil(doc) },
      );
    doc.y += 6;
  }

  asegurarEspacioConPie(doc, 34);
  dibujarBarra(doc, doc.page.margins.left, doc.y, anchoUtil(doc), modelo.compliance.pct, modelo.umbral);
  doc.y += 30;
  doc.x = doc.page.margins.left;

  dibujarMotivoIncompleta(doc, modelo);
  dibujarLineaTiempoDeRonda(doc, modelo);
  dibujarTablaPuntos(doc, modelo);
  dibujarOmitidos(doc, modelo);
}

/** "13 min", o por que no hay duracion que mostrar. */
function textoDuracion(modelo: InformeRonda): string {
  if (modelo.ejecucion.inicio === null) return 'No iniciada';
  if (modelo.ejecucion.cierre === null) return 'Sin cierre registrado';
  return modelo.duracionMin === null ? '—' : redactarDuracion(modelo.duracionMin);
}

/**
 * Las cifras salen TAL CUAL de `compliance`. Contar filas para obtenerlas es el
 * bug clasico: el encabezado terminaria contradiciendo a la tabla de abajo.
 */
function indicadoresDe(modelo: InformeRonda): Indicador[] {
  const { compliance, umbral } = modelo;
  const color = compliance.belowThreshold ? PALETA.alerta : PALETA.ok;
  const omitidos = compliance.expected - compliance.scanned;
  const conMarcas = compliance.scanned - compliance.clean;

  const indicadores: Indicador[] = [
    {
      rotulo: 'Cumplimiento',
      cifra: `${compliance.pct}%`,
      // Impreso en blanco y negro el rojo no se distingue del verde: el
      // veredicto va escrito, no solo pintado.
      detalle: `${compliance.belowThreshold ? 'BAJO EL UMBRAL' : 'Sobre el umbral'} · umbral ${umbral}%`,
      color,
    },
    { rotulo: 'Puntos', cifra: String(compliance.expected) },
    { rotulo: 'Escaneados', cifra: String(compliance.scanned) },
    {
      rotulo: 'Omitidos',
      cifra: String(omitidos),
      ...(omitidos > 0 ? { color: PALETA.alerta } : {}),
    },
  ];

  if (conMarcas > 0) {
    indicadores.push({ rotulo: 'Con marcas', cifra: String(conMarcas), color: PALETA.alerta });
  }
  // Una ronda sin checklist no gana ninguna ficha: ni vacia, ni en cero.
  if (modelo.tareas.length > 0) {
    const resumen = resumirTareas(modelo.tareas);
    indicadores.push({
      rotulo: 'Tareas',
      cifra: `${resumen.cumplidas}/${resumen.total}`,
      ...(resumen.cumplidas < resumen.total ? { color: PALETA.alerta } : {}),
    });
  }
  return indicadores;
}

/** Solo si hay algo que explicar: una ronda perfecta no recibe un recuadro vacio. */
function dibujarMotivoIncompleta(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  const motivos = redactarMotivoIncompleta(modelo);
  if (motivos.length === 0) return;

  dibujarTituloSeccion(doc, 'Motivo de ronda incompleta', PALETA.alerta);
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.tinta);
  for (const motivo of motivos) {
    asegurarEspacioConPie(doc, 16);
    doc.font('Helvetica').fontSize(9).fillColor(PALETA.tinta)
      .text(`•  ${motivo}`, doc.page.margins.left + 6, doc.y, { width: anchoUtil(doc) - 12 });
    doc.y += 2;
  }
  doc.y += 6;
  doc.x = doc.page.margins.left;
}

function dibujarLineaTiempoDeRonda(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  dibujarTituloSeccion(doc, 'Línea de tiempo de la ronda');

  const hitos: HitoLinea[] = [];
  for (const punto of modelo.puntos) {
    if (punto.escaneadoEn === null) continue;
    hitos.push({
      instante: punto.escaneadoEn,
      forma: punto.anomalias.length > 0 ? 'escaneo_marcado' : 'escaneo',
    });
  }
  for (const tarea of modelo.tareas) {
    if (tarea.respondidaEn !== null) hitos.push({ instante: tarea.respondidaEn, forma: 'tarea' });
  }
  for (const incidente of modelo.incidentes) {
    hitos.push({
      instante: incidente.reportadoEn,
      forma: incidente.destacado ? 'incidente_grave' : 'incidente',
    });
  }

  // Los omitidos NO se dibujan: no tienen hora, y ponerlos en algun lado seria
  // inventarla. Se dicen debajo del eje.
  const nota =
    modelo.omitidos.length > 0
      ? `${modelo.omitidos.length} punto(s) omitido(s) no aparecen en la línea: no tienen hora.`
      : null;

  dibujarLineaDeTiempo(doc, {
    ventana: modelo.ventana,
    ejecucion: modelo.ejecucion,
    hitos,
    colorMarca: modelo.marca.primaryColor,
    timezone: modelo.timezone,
    nota,
  });
}

function dibujarTablaPuntos(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  dibujarTituloSeccion(doc, 'Puntos de la ronda');
  dibujarTabla(
    doc,
    [
      { titulo: 'Nº', ancho: 26, alinear: 'right' },
      { titulo: 'Punto', ancho: 168 },
      { titulo: 'Estado', ancho: 70 },
      { titulo: 'Fecha y hora', ancho: 104 },
      { titulo: 'Método', ancho: 42 },
      { titulo: 'Marcas', ancho: 105 },
    ],
    modelo.puntos.map((punto) => {
      const etiquetas: string[] = [];
      if (punto.esCritico) etiquetas.push('CRÍTICO');
      if (punto.esCierre) etiquetas.push('CIERRE');
      const nombre = etiquetas.length
        ? `${punto.nombre} · ${etiquetas.join(' · ')}`
        : punto.nombre;
      return [
        { texto: String(punto.numero) },
        { texto: recortar(nombre, 38) },
        // "OMITIDO" en mayuscula y negrita: se ve a la primera pasada de ojo y
        // sobrevive a una impresora en blanco y negro.
        punto.omitido
          ? { texto: 'OMITIDO', color: PALETA.alerta, negrita: true }
          : { texto: 'Escaneado', color: PALETA.ok },
        // La celda vacia del informe de referencia se reemplaza por un guion:
        // un blanco se lee como una falla de impresion, no como un dato ausente.
        { texto: formatearFechaHora(punto.escaneadoEn, modelo.timezone) },
        { texto: punto.metodo ? punto.metodo.toUpperCase() : '—' },
        celdaMarcas(punto, modelo),
      ];
    }),
  );
}

/**
 * La columna antifraude: anomalias y desvio de turno en el mismo lugar.
 *
 * Si esa marca no se ve en el informe, el informe da la falsa sensacion de
 * control que CLAUDE.md nombra como peor que no tener sistema.
 */
function celdaMarcas(
  punto: InformeRonda['puntos'][number],
  modelo: InformeRonda,
): Celda {
  const partes = punto.anomalias.map(etiquetaAnomalia);
  const desvio = desvioDeTurno(punto.escaneadoEn, modelo.ventana);
  if (desvio) partes.push(`${desvio.minutos} min fuera de turno`);
  if (partes.length === 0) return { texto: '—' };
  return { texto: recortar(partes.join(', '), 30), color: PALETA.alerta };
}

function dibujarOmitidos(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  if (modelo.omitidos.length === 0) return;

  dibujarTituloSeccion(
    doc,
    `Puntos omitidos (${modelo.omitidos.length} de ${modelo.compliance.expected})`,
    PALETA.alerta,
  );
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.tinta);
  for (const punto of modelo.omitidos) {
    asegurarEspacioConPie(doc, 14);
    doc.text(
      `•  ${punto.numero}. ${punto.nombre}${punto.esCritico ? '  — acceso crítico' : ''}`,
      doc.page.margins.left + 6,
      doc.y,
      { width: anchoUtil(doc) - 12 },
    );
  }
  doc.y += 4;
}

// --------------------------------------------------------------- la bitacora

/**
 * La ronda contada hora por hora, con las fotos y el checklist en linea (#308).
 *
 * El orden y el reparto de la evidencia los decide `construirBitacora`, que es
 * una funcion pura del modelo: aca solo se dibuja. Esa separacion es lo que
 * permite probar el criterio de orden sin abrir un PDF.
 */
async function dibujarBitacora(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  opciones: OpcionesRender,
): Promise<ResumenRender> {
  const bitacora = construirBitacora(modelo, {
    ...(opciones.maxEntradasBitacora === undefined
      ? {}
      : { maxEntradas: opciones.maxEntradasBitacora }),
  });

  const embebe = modelo.incluyeAnexo && opciones.fotosEnLinea !== false;
  let incluidas = 0;
  let omitidas = 0;

  if (bitacora.entradas.length === 0) {
    // Ni titulo ni cabecera: una seccion vacia en un informe que va al cliente
    // se lee como un dato faltante, no como una funcion que no aplica.
    return dibujarCierreBitacora(doc, bitacora, modelo, opciones, embebe);
  }

  doc.addPage();
  dibujarTituloSeccion(doc, 'Bitácora de la ronda');
  dibujarCabeceraBitacora(doc);

  let diaAnterior: string | null = null;

  for (const entrada of bitacora.entradas) {
    const dia = formatearFecha(entrada.instante, modelo.timezone);
    if (dia !== diaAnterior) {
      dibujarSeparadorDia(doc, dia);
      diaAnterior = dia;
    }

    const lineas = lineasDeEntrada(entrada, modelo, embebe);
    const area = dibujarFilaBitacora(doc, {
      hora: formatearHora(entrada.instante, modelo.timezone),
      evento: eventoDeEntrada(entrada),
      lineas,
      // Se reserva la PRIMERA foto junto al texto para que un escaneo no quede
      // separado de su evidencia; las siguientes paginan por su cuenta.
      ...(embebe && entrada.fotos.length > 0
        ? { altoExtra: ALTO_FOTO_LINEA + ALTO_ROTULO_FOTO + 4 }
        : {}),
      ...(entrada.incidente?.destacado ? { destacado: true } : {}),
    });

    if (!embebe) continue;
    // Donde termino el bloque de texto ya reservado, para no retroceder debajo.
    const yTrasFila = doc.y;
    for (const [indice, foto] of entrada.fotos.entries()) {
      const primera = indice === 0;
      if (!primera) asegurarEspacioConPie(doc, ALTO_BLOQUE_FOTO);
      const y = primera ? area.y + 2 : doc.y;

      const resultado = await pintarEvidencia(doc, modelo, foto, opciones, area.x, y);
      if (resultado) incluidas += 1;
      else omitidas += 1;

      // pintarEvidencia escribe el rotulo y con eso deja el cursor de pdfkit A
      // MEDIA foto: sin reponerlo, la anotacion siguiente se dibuja encima de la
      // linea de la tarea y del borde inferior de la imagen.
      doc.y = Math.max(primera ? yTrasFila : 0, y + ALTO_BLOQUE_FOTO);
      await cederHastaDrenar(doc);
    }
  }

  if (bitacora.omitidasPorTope > 0) {
    asegurarEspacioConPie(doc, 20);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETA.gris)
      .text(
        `Se omitieron ${bitacora.omitidasPorTope} anotación(es) por extensión del informe. ` +
          'La bitácora completa está en el panel.',
        doc.page.margins.left,
        doc.y,
        { width: anchoUtil(doc) },
      );
    doc.y += 10;
  }

  const cierre = await dibujarCierreBitacora(doc, bitacora, modelo, opciones, embebe);
  return {
    fotosIncluidas: incluidas + cierre.fotosIncluidas,
    fotosOmitidas: omitidas + cierre.fotosOmitidas,
    paginasAnexo: 0,
  };
}

function dibujarCabeceraBitacora(doc: PDFKit.PDFDocument): void {
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETA.gris);
  doc.text('TIEMPO', x, y, { width: 44, lineBreak: false });
  doc.text('ACCIÓN', x + 44, y, { width: 96, lineBreak: false });
  doc.text('DETALLES', x + 140, y, { width: ancho - 140, lineBreak: false });
  doc.lineWidth(0.8);
  doc.moveTo(x, y + 11).lineTo(x + ancho, y + 11).stroke(PALETA.gris);
  doc.x = x;
  doc.y = y + 16;
}

function eventoDeEntrada(entrada: EntradaBitacora): string {
  switch (entrada.tipo) {
    case 'inicio':
      return 'Inicio de ronda';
    case 'escaneo':
      return `Escaneo · punto ${entrada.punto?.numero ?? '—'}`;
    case 'tarea':
      return 'Lista de verificación';
    case 'incidente':
      return `Novedad · ${CRITICIDADES[entrada.incidente?.criticidad ?? ''] ?? entrada.incidente?.criticidad ?? ''}`;
    default:
      return 'Cierre de ronda';
  }
}

/**
 * El contenido de una anotacion.
 *
 * Cada linea condicional existe porque aporta algo que el lector no puede
 * deducir: una ronda sin checklist, sin anomalias y sin instrucciones cargadas
 * produce exactamente dos lineas por escaneo, no ocho vacias.
 */
function lineasDeEntrada(
  entrada: EntradaBitacora,
  modelo: InformeRonda,
  embebe: boolean,
): LineaBitacora[] {
  const lineas: LineaBitacora[] = [];

  if (entrada.tipo === 'inicio') {
    lineas.push({ texto: `${modelo.recinto.ruta} · ${modelo.recinto.guardia}`, negrita: true });
    lineas.push({
      texto:
        `Ventana programada ${formatearHora(modelo.ventana.desde, modelo.timezone)}` +
        ` — ${formatearHora(modelo.ventana.hasta, modelo.timezone)}`,
      tamano: 8,
      color: PALETA.gris,
    });
  }

  if (entrada.tipo === 'escaneo' && entrada.punto) {
    const punto = entrada.punto;
    const etiquetas: string[] = [];
    if (punto.esCritico) etiquetas.push('CRÍTICO');
    if (punto.esCierre) etiquetas.push('CIERRE');
    lineas.push({
      texto: `${punto.numero}. ${punto.nombre}${etiquetas.length ? ` · ${etiquetas.join(' · ')}` : ''}`,
      negrita: true,
    });
    lineas.push({
      texto: `Método ${punto.metodo ? punto.metodo.toUpperCase() : '—'}`,
      tamano: 8,
      color: PALETA.gris,
    });
    if (punto.instrucciones) {
      lineas.push({ texto: `Instrucciones: ${recortar(punto.instrucciones, 220)}`, tamano: 8 });
    }
    if (punto.anomalias.length > 0) {
      lineas.push({
        texto: `Marcas: ${punto.anomalias.map(etiquetaAnomalia).join(', ')}`,
        negrita: true,
        color: PALETA.alerta,
      });
    }
    const desvio = desvioDeTurno(punto.escaneadoEn, modelo.ventana);
    if (desvio) lineas.push({ texto: desvio.texto, color: PALETA.alerta, tamano: 8 });
  }

  if (entrada.tipo === 'tarea' && entrada.tarea) {
    const tarea = entrada.tarea;
    lineas.push({ texto: tarea.etiqueta, negrita: true });
    if (tarea.respuesta !== null) {
      // El valor va TAL CUAL quedo guardado: el informe no puede decir algo
      // distinto de lo que el guardia vio en el teléfono.
      lineas.push({ texto: `Respuesta: ${tarea.respuesta}`, tamano: 8 });
    }
    if (tarea.estado !== 'cumplida') {
      lineas.push({ texto: textoEstadoTarea(tarea.estado), negrita: true, color: PALETA.alerta });
    }
    if (tarea.observacion) {
      lineas.push({ texto: `Observación: ${tarea.observacion}`, tamano: 8 });
    }
    const atraso = redactarAtrasoDeTarea(tarea.atrasoMinutos);
    if (atraso) {
      lineas.push({
        // Los minutos se imprimen tal como los guardo el servidor: recalcularlos
        // con otra zona horaria daria una cifra distinta a la que ya vio el guardia.
        texto: `Hora pedida ${tarea.horaPedida ?? '—'} · ${atraso}`,
        color: PALETA.alerta,
        tamano: 8,
      });
    }
    if (tarea.faltaFoto) {
      lineas.push({ texto: 'FOTO EXIGIDA: NO ADJUNTA', negrita: true, color: PALETA.alerta });
    }
  }

  if (entrada.tipo === 'incidente' && entrada.incidente) {
    // El texto va completo: el libro de novedades es append-only y termina en
    // juicios laborales; un registro recortado a 78 caracteres no sirve de prueba.
    lineas.push({ texto: recortar(entrada.incidente.texto, 400) });
  }

  if (entrada.tipo === 'cierre') {
    const { compliance } = modelo;
    const duracion = modelo.duracionMin === null ? null : redactarDuracion(modelo.duracionMin);
    lineas.push({
      texto:
        `${compliance.scanned} de ${compliance.expected} puntos · ${compliance.pct}%` +
        (duracion ? ` · duración ${duracion}` : ''),
      negrita: true,
    });
  }

  // Sin bytes la evidencia igual queda anotada: esconder la imagen es una
  // decision de tamaño de adjunto; esconder el hecho seria tergiversar la ronda
  // ante quien recibe el informe.
  if (!embebe) {
    const donde = modelo.incluyeAnexo
      ? 'ver anexo fotográfico'
      : 'imagen no incluida en este envío';
    for (const foto of entrada.fotos) {
      lineas.push({
        texto: `${rotuloFoto(foto, modelo)} · ${donde}`,
        tamano: 7.5,
        color: PALETA.gris,
      });
    }
  }

  return lineas;
}

function textoEstadoTarea(estado: EstadoTarea): string {
  return estado === 'falla' ? 'FALLA' : 'NO HECHA';
}

/** La huella sha256 en cada aparicion es el enganche antifraude de la evidencia. */
function rotuloFoto(foto: FotoAnexo, modelo: InformeRonda): string {
  return `Foto ${foto.numero} · ${formatearHora(foto.capturadaEn, modelo.timezone)} · huella ${foto.huella}`;
}

/** Dibuja una foto incrustada con su rotulo. Devuelve false si no se pudo leer. */
async function pintarEvidencia(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  foto: FotoAnexo,
  opciones: OpcionesRender,
  x: number,
  y: number,
): Promise<boolean> {
  const caja = { x, y, ancho: ANCHO_FOTO_LINEA, alto: ALTO_FOTO_LINEA };
  const lectura = await leerEvidencia(opciones.raizEvidencia, foto.storagePath, foto.mimeType, {
    maxBytes: opciones.maxBytesFoto,
  });

  let ok = false;
  if (lectura.ok) {
    ok = dibujarImagen(doc, lectura.contenido, caja);
    if (!ok) {
      opciones.onEvidenciaFallida?.(foto.id, 'ilegible');
      dibujarHuecoEvidencia(doc, caja, MOTIVO_TEXTO.ilegible);
    }
  } else {
    opciones.onEvidenciaFallida?.(foto.id, lectura.motivo);
    dibujarHuecoEvidencia(doc, caja, MOTIVO_TEXTO[lectura.motivo]);
  }

  doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
    .text(rotuloFoto(foto, modelo), x, y + ALTO_FOTO_LINEA + 2, {
      width: ANCHO_FOTO_LINEA,
      lineBreak: false,
    });
  if (foto.tarea !== null) {
    doc.fontSize(7).fillColor(PALETA.tinta)
      .text(`Tarea: ${recortar(foto.tarea, 40)}`, x, y + ALTO_FOTO_LINEA + 11, {
        width: ANCHO_FOTO_LINEA,
        lineBreak: false,
      });
  }
  return ok;
}

/**
 * Lo que no tiene hora, despues de la cronologia.
 *
 * La tarea NO hecha es el dato que mas le importa al supervisor y es justamente
 * la que no puede estar en una linea de tiempo, porque nunca ocurrio.
 * Inventarle la hora pedida como si fuera la hora en que paso seria escribir en
 * el informe algo que no sucedio.
 */
async function dibujarCierreBitacora(
  doc: PDFKit.PDFDocument,
  bitacora: Bitacora,
  modelo: InformeRonda,
  opciones: OpcionesRender,
  embebe: boolean,
): Promise<ResumenRender> {
  if (bitacora.tareasSinResponder.length > 0) {
    dibujarTituloSeccion(
      doc,
      `Tareas sin responder (${bitacora.tareasSinResponder.length})`,
      PALETA.alerta,
    );
    for (const tarea of bitacora.tareasSinResponder) {
      asegurarEspacioConPie(doc, 14);
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.alerta)
        .text(
          `•  ${tarea.horaPedida ?? '—'} · ${tarea.etiqueta} · ${textoPunto(tarea.numeroPunto, tarea.punto)}`,
          doc.page.margins.left + 6,
          doc.y,
          { width: anchoUtil(doc) - 12 },
        );
    }
    doc.y += 6;
  }

  let incluidas = 0;
  let omitidas = 0;

  if (bitacora.evidenciaSinPunto.length > 0) {
    dibujarTituloSeccion(
      doc,
      `Evidencia sin punto en la ruta (${bitacora.evidenciaSinPunto.length})`,
    );
    for (const foto of bitacora.evidenciaSinPunto) {
      asegurarEspacioConPie(doc, 16);
      doc.font('Helvetica').fontSize(8.5).fillColor(PALETA.tinta)
        .text(
          `•  ${rotuloFoto(foto, modelo)} · ${foto.checkpointName}`,
          doc.page.margins.left + 6,
          doc.y,
          { width: anchoUtil(doc) - 12 },
        );
      if (!embebe) continue;

      // La imagen se dibuja tambien aca: si solo se listara el rotulo, la
      // evidencia de un punto que no estaba en la ruta desapareceria del PDF
      // justo cuando el anexo ya no se dibuja.
      asegurarEspacioConPie(doc, ALTO_BLOQUE_FOTO);
      const y = doc.y;
      const ok = await pintarEvidencia(doc, modelo, foto, opciones, doc.page.margins.left + 12, y);
      if (ok) incluidas += 1;
      else omitidas += 1;
      doc.y = y + ALTO_BLOQUE_FOTO;
      await cederHastaDrenar(doc);
    }
    doc.y += 6;
  }

  return { fotosIncluidas: incluidas, fotosOmitidas: omitidas, paginasAnexo: 0 };
}

// ------------------------------------------------------- tablas sin bitacora

/**
 * Tareas del turno (#265), el camino sin bitacora.
 *
 * Una ronda sin checklist NO dibuja nada: ni el titulo, ni una tabla vacia, ni
 * un "sin tareas". El informe de esas rondas queda como antes de #265.
 */
function dibujarTareas(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  if (modelo.tareas.length === 0) return;

  const resumen = resumirTareas(modelo.tareas);
  const hayProblemas =
    resumen.fallidas + resumen.pendientes + resumen.atrasadas + resumen.sinFoto > 0;

  dibujarTituloSeccion(
    doc,
    `Tareas del turno (${resumen.cumplidas} de ${resumen.total} cumplidas)`,
    hayProblemas ? PALETA.alerta : undefined,
  );

  const avisos: string[] = [];
  if (resumen.fallidas > 0) avisos.push(`${resumen.fallidas} con falla`);
  if (resumen.atrasadas > 0) avisos.push(`${resumen.atrasadas} fuera de la hora pedida`);
  if (resumen.pendientes > 0) avisos.push(`${resumen.pendientes} sin responder`);
  if (resumen.sinFoto > 0) avisos.push(`${resumen.sinFoto} sin la foto exigida`);

  doc.font(avisos.length > 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .fillColor(avisos.length > 0 ? PALETA.alerta : PALETA.gris)
    .text(
      avisos.length > 0
        ? avisos.join('  ·  ')
        : 'Todas las tareas se cumplieron dentro de su horario.',
      doc.page.margins.left,
      doc.y,
      { width: anchoUtil(doc) },
    );
  doc.y += 8;

  dibujarTabla(
    doc,
    [
      { titulo: 'Hora', ancho: 40 },
      { titulo: 'Tarea', ancho: 138 },
      { titulo: 'Punto', ancho: 84 },
      { titulo: 'Estado', ancho: 58 },
      { titulo: 'Respuesta', ancho: 95 },
      { titulo: 'Foto', ancho: 40 },
      { titulo: 'Atraso', ancho: 60 },
    ],
    modelo.tareas.map((tarea) => [
      // horaPedida ya viene como "11:00": NO pasa por formatearFechaHora, que
      // convertiria el `time` de PostgreSQL en una fecha invalida y en un '—'.
      { texto: tarea.horaPedida ?? '—' },
      { texto: recortar(tarea.etiqueta, 30) },
      { texto: recortar(textoPunto(tarea.numeroPunto, tarea.punto), 18) },
      celdaEstadoTarea(tarea.estado),
      { texto: tarea.respuesta ? recortar(tarea.respuesta.replaceAll('\n', ' '), 20) : '—' },
      tarea.faltaFoto
        ? { texto: 'FALTA', color: PALETA.alerta, negrita: true }
        : { texto: tarea.fotoId ? 'Sí' : '—' },
      tarea.atrasada
        ? { texto: `+${tarea.atrasoMinutos} min`, color: PALETA.alerta, negrita: true }
        : { texto: '—' },
    ]),
  );
}

/** Sin punto la tarea es del turno entero, y eso hay que decirlo, no dejarlo en blanco. */
function textoPunto(numero: number | null, nombre: string | null): string {
  if (nombre === null) return 'General del turno';
  return numero === null ? nombre : `${numero}. ${nombre}`;
}

function celdaEstadoTarea(estado: EstadoTarea): Celda {
  if (estado === 'falla') return { texto: 'FALLA', color: PALETA.alerta, negrita: true };
  if (estado === 'pendiente') {
    return { texto: 'NO HECHA', color: PALETA.alerta, negrita: true };
  }
  return { texto: 'Cumplida', color: PALETA.ok };
}

function dibujarIncidentes(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  dibujarTituloSeccion(doc, `Novedades e incidentes (${modelo.incidentes.length})`);
  if (modelo.incidentes.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
      .text('Sin novedades registradas en la ronda.', doc.page.margins.left, doc.y);
    doc.y += 12;
    return;
  }

  dibujarTabla(
    doc,
    [
      { titulo: 'Hora', ancho: 106 },
      { titulo: 'Criticidad', ancho: 80 },
      { titulo: 'Novedad', ancho: 329 },
    ],
    modelo.incidentes.map((incidente) => [
      { texto: formatearFechaHora(incidente.reportadoEn, modelo.timezone) },
      {
        texto: CRITICIDADES[incidente.criticidad] ?? incidente.criticidad,
        ...(incidente.destacado ? { color: PALETA.alerta, negrita: true } : {}),
      },
      { texto: recortar(incidente.texto.replaceAll('\n', ' '), 78) },
    ]),
  );
}

// -------------------------------------------------------------------- anexo

/**
 * Anexo fotografico, paginado y leido de a una foto.
 *
 * No se dibuja cuando la bitacora ya muestra las fotos donde ocurrieron: las
 * mismas 18 imagenes dos veces en el mismo PDF duplican el peso del archivo sin
 * agregar nada. Con `reportInlinePhotos` apagado el anexo vuelve a ser el unico
 * lugar donde se ven, que es justo para lo que existe ese interruptor.
 *
 * El bucle es secuencial a proposito. Leer las 40 en paralelo con Promise.all
 * seria mas rapido y traeria las 40 al heap a la vez, que es exactamente lo que
 * este diseño evita. El cuello de botella real es el disco, no el orden.
 */
async function dibujarAnexo(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  opciones: OpcionesRender,
): Promise<ResumenRender> {
  const yaEstanEnLinea = opciones.bitacora !== false && opciones.fotosEnLinea !== false;
  if (!modelo.incluyeAnexo || modelo.anexo.length === 0 || yaEstanEnLinea) return VACIO;

  const porPagina = COLUMNAS_ANEXO * FILAS_ANEXO;
  const paginas = Math.ceil(modelo.anexo.length / porPagina);
  let incluidas = 0;
  let omitidas = 0;
  let geometria = geometriaPagina(doc);

  for (const [indice, foto] of modelo.anexo.entries()) {
    const posicion = indice % porPagina;
    if (posicion === 0) {
      doc.addPage();
      dibujarFranjaMarca(
        doc,
        modelo.marca,
        `Anexo fotográfico · hoja ${Math.floor(indice / porPagina) + 1} de ${paginas}`,
      );
      geometria = geometriaPagina(doc);
    }

    const celda = celdaAnexo(geometria, posicion);
    const lectura = await leerEvidencia(
      opciones.raizEvidencia,
      foto.storagePath,
      foto.mimeType,
      { maxBytes: opciones.maxBytesFoto },
    );

    const caja = { x: celda.x, y: celda.y, ancho: celda.ancho, alto: celda.alto - ALTO_LEYENDA };
    if (lectura.ok) {
      const dibujada = dibujarImagen(doc, lectura.contenido, caja);
      if (dibujada) {
        incluidas += 1;
      } else {
        omitidas += 1;
        opciones.onEvidenciaFallida?.(foto.id, 'ilegible');
        dibujarHuecoEvidencia(doc, caja, MOTIVO_TEXTO.ilegible);
      }
    } else {
      omitidas += 1;
      opciones.onEvidenciaFallida?.(foto.id, lectura.motivo);
      dibujarHuecoEvidencia(doc, caja, MOTIVO_TEXTO[lectura.motivo]);
    }

    dibujarLeyendaFoto(doc, foto, celda, modelo.timezone, lectura.ok);
    await cederHastaDrenar(doc);
  }

  return { fotosIncluidas: incluidas, fotosOmitidas: omitidas, paginasAnexo: paginas };
}

/** Espera a que el consumidor se ponga al dia antes de generar la foto siguiente. */
async function cederHastaDrenar(doc: PDFKit.PDFDocument): Promise<void> {
  let esperas = 0;
  while (doc.readableLength > TECHO_BUFFER_BYTES && esperas < MAX_ESPERAS_DRENAJE) {
    await new Promise((continuar) => setTimeout(continuar, 2));
    esperas += 1;
  }
}

function geometriaPagina(doc: PDFKit.PDFDocument): GeometriaAnexo {
  return {
    x0: doc.page.margins.left,
    ancho: anchoUtil(doc),
    yInicio: doc.y,
    yLimite: limiteInferior(doc) - ALTO_PIE,
    columnas: COLUMNAS_ANEXO,
    filas: FILAS_ANEXO,
    separacion: SEPARACION_ANEXO,
  };
}

interface Caja {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

/** Devuelve false si pdfkit no pudo embeber la imagen; nunca lanza. */
function dibujarImagen(doc: PDFKit.PDFDocument, contenido: Buffer, caja: Caja): boolean {
  try {
    doc.save();
    doc.lineWidth(0.5);
    doc.rect(caja.x, caja.y, caja.ancho, caja.alto).stroke(PALETA.linea);
    // Se pasa el Buffer, no la ruta: ver la nota de memoria al inicio.
    doc.image(contenido, caja.x + 2, caja.y + 2, {
      fit: [caja.ancho - 4, caja.alto - 4],
      align: 'center',
      valign: 'center',
    });
    doc.restore();
    return true;
  } catch {
    // Una imagen con cabecera valida y cuerpo roto revienta recien aca. El
    // recuadro queda marcado y el informe sigue.
    doc.restore();
    return false;
  }
}

function dibujarHuecoEvidencia(doc: PDFKit.PDFDocument, caja: Caja, motivo: string): void {
  doc.save();
  doc.rect(caja.x, caja.y, caja.ancho, caja.alto).fill(PALETA.zebra);
  doc.lineWidth(0.8);
  doc.rect(caja.x, caja.y, caja.ancho, caja.alto).stroke(PALETA.alerta);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.alerta)
    .text('EVIDENCIA NO DISPONIBLE', caja.x + 6, caja.y + caja.alto / 2 - 12, {
      width: caja.ancho - 12,
      align: 'center',
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
    .text(motivo, caja.x + 6, caja.y + caja.alto / 2 + 2, {
      width: caja.ancho - 12,
      align: 'center',
      lineBreak: false,
    });
  doc.restore();
}

function dibujarLeyendaFoto(
  doc: PDFKit.PDFDocument,
  foto: FotoAnexo,
  celda: CeldaAnexo,
  timezone: string,
  disponible: boolean,
): void {
  const y = celda.y + celda.alto - ALTO_LEYENDA + 4;
  const punto =
    foto.numeroPunto === null ? foto.checkpointName : `${foto.numeroPunto}. ${foto.checkpointName}`;

  // El mismo numero que en la bitacora: "la foto 12" significa lo mismo en las
  // dos secciones.
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETA.tinta)
    .text(recortar(`Foto ${foto.numero} · ${punto}`, 40), celda.x, y, {
      width: celda.ancho,
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
    .text(
      `${formatearHora(foto.capturadaEn, timezone)} · huella ${foto.huella}` +
        (disponible ? '' : ' · falta el archivo'),
      celda.x,
      y + 11,
      { width: celda.ancho, lineBreak: false },
    );
  // Tercera linea SOLO cuando la foto es evidencia de una tarea: sin esto, la
  // foto del refrigerador se ve rotulada con el punto y nadie sabe que responde
  // a la tarea de las 11. La ronda sin checklist no gana ninguna linea.
  if (foto.tarea !== null) {
    doc.fontSize(7).fillColor(PALETA.tinta)
      .text(`Tarea: ${recortar(foto.tarea, 38)}`, celda.x, y + 21, {
        width: celda.ancho,
        lineBreak: false,
      });
  }
}

// -------------------------------------------------------------------- salida

function esperarFin(doc: PDFKit.PDFDocument, destino: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resuelto = false;
    const terminar = () => {
      if (resuelto) return;
      resuelto = true;
      resolve();
    };
    const fallar = (error: unknown) => {
      if (resuelto) return;
      resuelto = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    doc.on('error', fallar);
    destino.on('error', fallar);
    // 'close' cubre al cliente que corta la descarga a mitad de camino: sin el
    // la promesa se quedaria colgada y con ella el request.
    destino.on('finish', terminar);
    destino.on('close', terminar);
  });
}
