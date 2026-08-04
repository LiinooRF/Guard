import PDFDocument from 'pdfkit';

import {
  MOTIVO_TEXTO,
  leerEvidencia,
  leerLogoMarca,
  type MotivoEvidencia,
} from './evidence-reader';
import {
  CRITICIDADES,
  etiquetaAnomalia,
  type FotoAnexo,
  type InformeRonda,
} from './patrol-report.model';
import {
  ESTADOS_RONDA,
  MARGEN,
  PALETA,
  anchoUtil,
  asegurarEspacio,
  celdaAnexo,
  dibujarBarra,
  dibujarEncabezadoMarca,
  dibujarFicha,
  dibujarFranjaMarca,
  dibujarPie,
  dibujarTabla,
  dibujarTituloSeccion,
  formatearFechaHora,
  formatearHora,
  limiteInferior,
  recortar,
  type CeldaAnexo,
  type GeometriaAnexo,
} from './pdf-primitivas';

/**
 * Dibujo del informe de ronda en PDF (#85).
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
 * El anexo se recorre foto a foto: se lee UNA imagen del disco, se embebe y se
 * suelta la referencia antes de leer la siguiente. El pico de memoria es una
 * foto, no el album, y no depende del largo de la ronda.
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
}

export interface ResumenRender {
  readonly fotosIncluidas: number;
  readonly fotosOmitidas: number;
  readonly paginasAnexo: number;
}

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

  let resumen: ResumenRender = { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 };
  try {
    const logo = await leerLogoMarca(modelo.marca.logoUri ?? null, opciones.raizEvidencia, {
      maxBytes: opciones.maxBytesFoto,
    });
    dibujarCuerpo(doc, modelo, logo);
    resumen = await dibujarAnexo(doc, modelo, opciones);
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

// ------------------------------------------------------------------- cuerpo

function dibujarCuerpo(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  logo: Buffer | null,
): void {
  const tz = modelo.timezone;
  dibujarEncabezadoMarca(doc, modelo.marca, 'Informe de ronda', logo);

  dibujarFicha(doc, [
    ['Recinto', modelo.recinto.nombre],
    ['Sucursal', modelo.recinto.sucursal],
    ['Ruta', modelo.recinto.ruta],
    ['Guardia', modelo.recinto.guardia],
    [
      'Ventana horaria',
      `${formatearFechaHora(modelo.ventana.desde, tz)} — ${formatearFechaHora(modelo.ventana.hasta, tz)}`,
    ],
    ['Inicio', formatearFechaHora(modelo.ejecucion.inicio, tz)],
    ['Cierre', formatearFechaHora(modelo.ejecucion.cierre, tz)],
    ['Estado', ESTADOS_RONDA[modelo.estado] ?? modelo.estado],
  ]);

  dibujarCumplimiento(doc, modelo);
  dibujarTablaPuntos(doc, modelo);
  dibujarOmitidos(doc, modelo);
  dibujarIncidentes(doc, modelo);
  dibujarPie(doc, tz, modelo.marca.mailFooter);
}

function dibujarCumplimiento(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  const { compliance, umbral } = modelo;
  asegurarEspacio(doc, 110);
  const x = doc.page.margins.left;
  const color = compliance.pct >= umbral ? PALETA.ok : PALETA.alerta;
  const y = doc.y;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
    .text('CUMPLIMIENTO', x, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(42).fillColor(color)
    .text(`${compliance.pct}%`, x, y + 10, { lineBreak: false });

  const xDetalle = x + 160;
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.tinta)
    .text(
      `${compliance.scanned} de ${compliance.expected} puntos escaneados`,
      xDetalle,
      y + 18,
      { lineBreak: false },
    );
  doc.fontSize(9).fillColor(PALETA.gris)
    .text(`Umbral configurado: ${umbral}%`, xDetalle, y + 33, { lineBreak: false });

  // Impreso en blanco y negro el rojo no se distingue del verde: el veredicto
  // va escrito, no solo pintado.
  doc.font('Helvetica-Bold').fontSize(9).fillColor(color)
    .text(
      compliance.belowThreshold ? 'BAJO EL UMBRAL' : 'Sobre el umbral',
      xDetalle,
      y + 47,
      { lineBreak: false },
    );
  if (compliance.scanned > compliance.clean) {
    doc.font('Helvetica').fontSize(9).fillColor(PALETA.alerta)
      .text(
        `${compliance.scanned - compliance.clean} punto(s) con anomalías marcadas`,
        xDetalle,
        y + 60,
        { lineBreak: false },
      );
  }

  dibujarBarra(doc, x, y + 76, anchoUtil(doc), compliance.pct, umbral);
  doc.x = x;
  doc.y = y + 110;
}

function dibujarTablaPuntos(doc: PDFKit.PDFDocument, modelo: InformeRonda): void {
  dibujarTituloSeccion(doc, 'Puntos de la ronda');
  dibujarTabla(
    doc,
    [
      { titulo: 'Nº', ancho: 26, alinear: 'right' },
      { titulo: 'Punto', ancho: 175 },
      { titulo: 'Estado', ancho: 74 },
      { titulo: 'Hora (servidor)', ancho: 106 },
      { titulo: 'Método', ancho: 40 },
      { titulo: 'Anomalías', ancho: 94 },
    ],
    modelo.puntos.map((punto) => {
      const etiquetas: string[] = [];
      if (punto.esCierre) etiquetas.push('cierre');
      if (punto.esCritico) etiquetas.push('crítico');
      const nombre = etiquetas.length
        ? `${punto.nombre} (${etiquetas.join(', ')})`
        : punto.nombre;
      return [
        { texto: String(punto.numero) },
        { texto: recortar(nombre, 42) },
        // "OMITIDO" en mayuscula y negrita: se ve a la primera pasada de ojo y
        // sobrevive a una impresora en blanco y negro.
        punto.omitido
          ? { texto: 'OMITIDO', color: PALETA.alerta, negrita: true }
          : { texto: 'Escaneado', color: PALETA.ok },
        { texto: formatearFechaHora(punto.escaneadoEn, modelo.timezone) },
        { texto: punto.metodo ? punto.metodo.toUpperCase() : '—' },
        punto.anomalias.length > 0
          ? {
              texto: recortar(punto.anomalias.map(etiquetaAnomalia).join(', '), 26),
              color: PALETA.alerta,
            }
          : { texto: '—' },
      ];
    }),
  );
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
    asegurarEspacio(doc, 14);
    doc.text(
      `•  ${punto.numero}. ${punto.nombre}${punto.esCritico ? '  — acceso crítico' : ''}`,
      doc.page.margins.left + 6,
      doc.y,
      { width: anchoUtil(doc) - 12 },
    );
  }
  doc.y += 4;
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
 * El bucle es secuencial a proposito. Leer las 40 en paralelo con Promise.all
 * seria mas rapido y traeria las 40 al heap a la vez, que es exactamente lo que
 * este diseño evita. El cuello de botella real es el disco, no el orden.
 */
async function dibujarAnexo(
  doc: PDFKit.PDFDocument,
  modelo: InformeRonda,
  opciones: OpcionesRender,
): Promise<ResumenRender> {
  if (!modelo.incluyeAnexo || modelo.anexo.length === 0) {
    return { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 };
  }

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
      // La geometria se fija ANTES del pie: dibujarPie escribe texto con
      // coordenadas y eso deja el cursor de pdfkit al fondo de la hoja.
      geometria = geometriaPagina(doc);
      dibujarPie(doc, modelo.timezone, modelo.marca.mailFooter);
    }

    const celda = celdaAnexo(geometria, posicion);
    const lectura = await leerEvidencia(
      opciones.raizEvidencia,
      foto.storagePath,
      foto.mimeType,
      { maxBytes: opciones.maxBytesFoto },
    );

    if (lectura.ok) {
      const dibujada = dibujarFoto(doc, lectura.contenido, celda);
      if (dibujada) {
        incluidas += 1;
      } else {
        omitidas += 1;
        opciones.onEvidenciaFallida?.(foto.id, 'ilegible');
        dibujarHuecoEvidencia(doc, celda, MOTIVO_TEXTO.ilegible);
      }
    } else {
      omitidas += 1;
      opciones.onEvidenciaFallida?.(foto.id, lectura.motivo);
      dibujarHuecoEvidencia(doc, celda, MOTIVO_TEXTO[lectura.motivo]);
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

/** Alto reservado al pie de la hoja del anexo. */
const ALTO_PIE = 26;

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

/** Devuelve false si pdfkit no pudo embeber la imagen; nunca lanza. */
function dibujarFoto(doc: PDFKit.PDFDocument, contenido: Buffer, celda: CeldaAnexo): boolean {
  const altoImagen = celda.alto - ALTO_LEYENDA;
  try {
    doc.save();
    doc.rect(celda.x, celda.y, celda.ancho, altoImagen).lineWidth(0.5).stroke(PALETA.linea);
    // Se pasa el Buffer, no la ruta: ver la nota de memoria al inicio.
    doc.image(contenido, celda.x + 2, celda.y + 2, {
      fit: [celda.ancho - 4, altoImagen - 4],
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

function dibujarHuecoEvidencia(
  doc: PDFKit.PDFDocument,
  celda: CeldaAnexo,
  motivo: string,
): void {
  const altoImagen = celda.alto - ALTO_LEYENDA;
  doc.save();
  doc.rect(celda.x, celda.y, celda.ancho, altoImagen).fill(PALETA.zebra);
  doc.rect(celda.x, celda.y, celda.ancho, altoImagen).lineWidth(0.8).stroke(PALETA.alerta);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.alerta)
    .text('EVIDENCIA NO DISPONIBLE', celda.x + 6, celda.y + altoImagen / 2 - 12, {
      width: celda.ancho - 12,
      align: 'center',
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
    .text(motivo, celda.x + 6, celda.y + altoImagen / 2 + 2, {
      width: celda.ancho - 12,
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
  const titulo =
    foto.numeroPunto === null
      ? foto.checkpointName
      : `${foto.numeroPunto}. ${foto.checkpointName}`;

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETA.tinta)
    .text(recortar(titulo, 40), celda.x, y, { width: celda.ancho, lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
    .text(
      `${formatearHora(foto.capturadaEn, timezone)} · huella ${foto.huella}` +
        (disponible ? '' : ' · falta el archivo'),
      celda.x,
      y + 11,
      { width: celda.ancho, lineBreak: false },
    );
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
