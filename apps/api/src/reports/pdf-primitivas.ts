import { checkContrast } from '@voxia/shared';

/**
 * Primitivas de dibujo compartidas por los informes en PDF (#17, #85).
 *
 * Este archivo NO importa pdfkit en runtime: recibe el documento ya creado y
 * usa el tipo global `PDFKit.PDFDocument` que declara @types/pdfkit. Asi los
 * modulos que solo componen datos no arrastran la libreria.
 *
 * Criterio de diseño: el informe se imprime en blanco y negro (criterio de
 * aceptacion del issue #85). Ningun estado se comunica SOLO con color — el
 * color acompaña a un texto que ya dice lo mismo. El color de marca del tenant
 * se usa como acento (filetes, franjas), nunca como unico portador de sentido.
 */

export const MARGEN = 40;

export const PALETA = {
  tinta: '#111111',
  gris: '#5f6368',
  linea: '#d0d3d8',
  fondoBarra: '#e8eaed',
  zebra: '#f4f5f7',
  ok: '#1e7e34',
  alerta: '#b02a37',
} as const;

/** Etiquetas legibles de patrolStatusSchema (@voxia/shared). */
export const ESTADOS_RONDA: Record<string, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  completada: 'Completada',
  incompleta: 'Incompleta',
  vencida: 'Vencida',
};

export interface Columna {
  titulo: string;
  ancho: number;
  alinear?: 'left' | 'right' | 'center';
}

export interface Celda {
  texto: string;
  color?: string;
  negrita?: boolean;
}

/**
 * La marca del tenant tal como la entrega BrandingService.forDocuments().
 *
 * Se declara aca —y no se importa el tipo del servicio— para que las capas de
 * composicion y dibujo no dependan de Nest ni de la base de datos.
 */
export interface MarcaDocumento {
  readonly displayName: string;
  /** Data URI o ruta relativa en el volumen de evidencia; null si no hay logo. */
  readonly logoUri: string | null;
  readonly primaryColor: string;
  readonly mailFooter: string | null;
}

export function anchoUtil(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

export function limiteInferior(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom;
}

export function asegurarEspacio(doc: PDFKit.PDFDocument, alto: number): void {
  if (doc.y + alto > limiteInferior(doc)) doc.addPage();
}

/**
 * Cabecera con la marca DEL TENANT, no la del revendedor.
 *
 * `logo` llega ya decodificado (PNG o JPEG) o en null: resolver el logo puede
 * fallar —archivo borrado, data URI corrupta, SVG— y un logo que no carga no
 * puede tumbar el informe. Sin logo se estampa solo el nombre, que es lo que
 * identifica al cliente.
 */
export function dibujarEncabezadoMarca(
  doc: PDFKit.PDFDocument,
  marca: MarcaDocumento,
  titulo: string,
  logo: Buffer | null,
): void {
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const yInicio = doc.page.margins.top;
  let xTexto = x;

  if (logo) {
    try {
      doc.image(logo, x, yInicio, { fit: [110, 34] });
      xTexto = x + 122;
    } catch {
      // Un logo que pdfkit no sabe leer degrada a informe sin logo. Nunca
      // aborta: el informe con el nombre del cliente sigue siendo valido.
      xTexto = x;
    }
  }

  doc.font('Helvetica-Bold').fontSize(16).fillColor(PALETA.tinta)
    .text(marca.displayName, xTexto, yInicio, { width: ancho - (xTexto - x), lineBreak: false });
  doc.font('Helvetica').fontSize(11).fillColor(PALETA.gris)
    .text(titulo, xTexto, doc.y + 3, { width: ancho - (xTexto - x), lineBreak: false });

  // Filete grueso en el color de marca: es el acento white-label. Impreso en
  // blanco y negro queda como una linea gris, y el informe se lee igual.
  const y = Math.max(doc.y + 10, yInicio + 40);
  doc.rect(x, y, ancho, 3).fill(marca.primaryColor);
  doc.y = y + 14;
  doc.x = x;
}

/** Franja de titulo sobre el color de marca, con el texto que SI contrasta. */
export function dibujarFranjaMarca(
  doc: PDFKit.PDFDocument,
  marca: MarcaDocumento,
  texto: string,
): void {
  asegurarEspacio(doc, 30);
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const alto = 20;
  const y = doc.y + 4;
  // checkContrast decide si el texto va blanco o negro sobre el color elegido
  // por el admin: un amarillo de marca con texto blanco encima es ilegible.
  const { fillText } = checkContrast(marca.primaryColor);
  doc.rect(x, y, ancho, alto).fill(marca.primaryColor);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(fillText)
    .text(texto.toUpperCase(), x + 8, y + 6, { width: ancho - 16, lineBreak: false });
  doc.x = x;
  doc.y = y + alto + 10;
}

export function dibujarFicha(
  doc: PDFKit.PDFDocument,
  filas: ReadonlyArray<readonly [string, string]>,
): void {
  const x = doc.page.margins.left;
  const anchoEtiqueta = 120;
  for (const [etiqueta, valor] of filas) {
    asegurarEspacio(doc, 16);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
      .text(etiqueta.toUpperCase(), x, y + 1, { width: anchoEtiqueta, lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.tinta)
      .text(valor, x + anchoEtiqueta + 10, y, {
        width: anchoUtil(doc) - anchoEtiqueta - 10,
        lineBreak: false,
      });
    doc.y = y + 16;
  }
  doc.x = x;
  doc.y += 8;
}

export function dibujarTituloSeccion(
  doc: PDFKit.PDFDocument,
  texto: string,
  color?: string,
): void {
  asegurarEspacio(doc, 40);
  const x = doc.page.margins.left;
  doc.y += 6;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(color ?? PALETA.tinta)
    .text(texto, x, doc.y, { width: anchoUtil(doc), lineBreak: false });
  doc.y += 18;
  doc.x = x;
}

export function dibujarTabla(
  doc: PDFKit.PDFDocument,
  columnas: readonly Columna[],
  filas: ReadonlyArray<readonly Celda[]>,
): void {
  const x0 = doc.page.margins.left;
  const anchoTotal = columnas.reduce((suma, col) => suma + col.ancho, 0);
  const altoFila = 17;
  let y = doc.y;

  const cabecera = () => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETA.gris);
    let cx = x0;
    for (const col of columnas) {
      doc.text(col.titulo.toUpperCase(), cx + 3, y + 4, {
        width: col.ancho - 6,
        align: col.alinear ?? 'left',
        lineBreak: false,
      });
      cx += col.ancho;
    }
    y += altoFila;
    doc.moveTo(x0, y).lineTo(x0 + anchoTotal, y).lineWidth(0.8).stroke(PALETA.gris);
  };

  cabecera();
  filas.forEach((fila, indice) => {
    if (y + altoFila > limiteInferior(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
      cabecera();
    }
    if (indice % 2 === 1) {
      doc.rect(x0, y, anchoTotal, altoFila).fill(PALETA.zebra);
    }
    let cx = x0;
    fila.forEach((celda, j) => {
      const col = columnas[j]!;
      doc.font(celda.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .fillColor(celda.color ?? PALETA.tinta)
        .text(celda.texto, cx + 3, y + 4, {
          width: col.ancho - 6,
          align: col.alinear ?? 'left',
          lineBreak: false,
        });
      cx += col.ancho;
    });
    y += altoFila;
    doc.moveTo(x0, y).lineTo(x0 + anchoTotal, y).lineWidth(0.4).stroke(PALETA.linea);
  });

  doc.x = x0;
  doc.y = y + 8;
}

export function dibujarBarra(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  ancho: number,
  pct: number,
  umbral: number,
): void {
  const alto = 12;
  doc.roundedRect(x, y, ancho, alto, 3).fill(PALETA.fondoBarra);
  const relleno = (Math.max(0, Math.min(100, pct)) / 100) * ancho;
  if (relleno > 0) {
    doc.roundedRect(x, y, relleno, alto, 3).fill(pct >= umbral ? PALETA.ok : PALETA.alerta);
  }
  const xUmbral = x + (Math.max(0, Math.min(100, umbral)) / 100) * ancho;
  doc.moveTo(xUmbral, y - 3).lineTo(xUmbral, y + alto + 3).lineWidth(1).stroke(PALETA.tinta);
  doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
    .text(`umbral ${umbral}%`, Math.min(xUmbral - 20, x + ancho - 50), y + alto + 5, {
      lineBreak: false,
    });
}

/**
 * Pie del documento. Cierra con el `mailFooter` del tenant cuando existe: es su
 * linea legal, y un informe white-label sin ella es un informe a medio marcar.
 */
export function dibujarPie(
  doc: PDFKit.PDFDocument,
  timezone: string,
  mailFooter?: string | null,
): void {
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const yBase = limiteInferior(doc);
  doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
    .text(
      `Documento generado automáticamente el ${formatearFechaHora(new Date(), timezone)}`,
      x,
      yBase - 12,
      { width: ancho, lineBreak: false },
    );
  if (mailFooter) {
    doc.fontSize(7).text(recortar(mailFooter.replaceAll('\n', ' '), 150), x, yBase - 22, {
      width: ancho,
      lineBreak: false,
    });
  }
}

// ------------------------------------------------------- cuadricula del anexo

export interface CeldaAnexo {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

export interface GeometriaAnexo {
  readonly x0: number;
  readonly ancho: number;
  /** Borde superior de la cuadricula, ya descontado el titulo de la hoja. */
  readonly yInicio: number;
  /** Borde inferior utilizable, ya descontado el pie. */
  readonly yLimite: number;
  readonly columnas: number;
  readonly filas: number;
  readonly separacion: number;
}

/**
 * Posicion de una celda de la cuadricula del anexo fotografico.
 *
 * Es aritmetica pura y esta afuera del dibujo a proposito: el bug facil aca es
 * leer `doc.y` despues de haber escrito el pie de pagina —que mueve el cursor
 * al fondo de la hoja— y terminar con celdas de alto negativo que pdfkit dibuja
 * sin quejarse. Con la geometria calculada aparte, eso se prueba.
 */
export function celdaAnexo(geometria: GeometriaAnexo, posicion: number): CeldaAnexo {
  const { x0, ancho, yInicio, yLimite, columnas, filas, separacion } = geometria;
  const anchoCelda = (ancho - separacion * (columnas - 1)) / columnas;
  const altoCelda = (yLimite - yInicio - separacion * (filas - 1)) / filas;
  const columna = posicion % columnas;
  const fila = Math.floor(posicion / columnas);
  return {
    x: x0 + columna * (anchoCelda + separacion),
    y: yInicio + fila * (altoCelda + separacion),
    ancho: anchoCelda,
    alto: altoCelda,
  };
}

// ------------------------------------------------------------------ formato

export function recortar(texto: string, largo: number): string {
  return texto.length > largo ? `${texto.slice(0, largo - 1)}…` : texto;
}

/** "aaaammdd" para nombres de archivo, siempre en UTC para que sea estable. */
export function claveFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Las horas del informe van en la zona horaria DEL RECINTO, no del servidor. */
export function formatearFechaHora(valor: Date | string | null, timezone: string): string {
  if (valor === null) return '—';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(fecha);
  } catch {
    return fecha.toISOString();
  }
}

/** Solo la hora: en el anexo la fecha ya la da el encabezado de la ronda. */
export function formatearHora(valor: Date | null, timezone: string): string {
  if (valor === null) return '—';
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(valor);
  } catch {
    return valor.toISOString().slice(11, 16);
  }
}

export function formatearFecha(fecha: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(fecha);
  } catch {
    return fecha.toISOString().slice(0, 10);
  }
}

export function formatearDiaMes(fecha: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
    }).format(fecha);
  } catch {
    return fecha.toISOString().slice(5, 10);
  }
}
