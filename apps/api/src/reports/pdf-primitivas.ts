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

/**
 * Alto reservado al pie. Desde #308 el pie se dibuja en TODAS las hojas, asi
 * que cualquier bloque que llegue al fondo de la pagina tiene que descontarlo o
 * se escribe encima de la linea legal del tenant.
 */
export const ALTO_PIE = 26;

/** Ultima linea utilizable de la hoja, ya descontado el pie. */
export function limiteConPie(doc: PDFKit.PDFDocument): number {
  return limiteInferior(doc) - ALTO_PIE;
}

export function asegurarEspacio(doc: PDFKit.PDFDocument, alto: number): void {
  if (doc.y + alto > limiteInferior(doc)) doc.addPage();
}

/** Como asegurarEspacio, pero sin invadir el pie de la hoja. */
export function asegurarEspacioConPie(doc: PDFKit.PDFDocument, alto: number): void {
  if (doc.y + alto > limiteConPie(doc)) doc.addPage();
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
    // Con pie en todas las hojas (#308) el limite ya no es el borde del margen:
    // una fila mas y la tabla se escribiria sobre la linea legal del tenant.
    if (y + altoFila > limiteConPie(doc)) {
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
 *
 * Lleva "Página N" a secas y NUNCA "N de M". El documento se genera con
 * `bufferPages` en false a proposito (ver la nota de memoria del renderer): una
 * ronda de 40 fotos son ~120 MB y retener las paginas ya cerradas para volver
 * atras a estampar el total es exactamente el pico de memoria que ese diseño
 * existe para evitar. Si alguien "arregla" esto prendiendo bufferPages, tumba
 * el proceso de la API con tres descargas simultaneas.
 */
export function dibujarPie(
  doc: PDFKit.PDFDocument,
  timezone: string,
  mailFooter?: string | null,
  pagina?: number,
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
  if (pagina !== undefined) {
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
      .text(`Página ${pagina}`, x, yBase - 12, {
        width: ancho,
        align: 'right',
        lineBreak: false,
      });
  }
  if (mailFooter) {
    doc.font('Helvetica').fontSize(7)
      .text(recortar(mailFooter.replaceAll('\n', ' '), 150), x, yBase - 22, {
        width: ancho,
        lineBreak: false,
      });
  }
}

// --------------------------------------------------- bloque de indicadores

export interface Indicador {
  readonly rotulo: string;
  readonly cifra: string;
  /** Linea chica bajo la cifra; el veredicto va ESCRITO, no solo pintado. */
  readonly detalle?: string;
  readonly color?: string;
}

const ANCHO_INDICADOR = 96;
const ALTO_INDICADOR = 46;
const SEPARACION_INDICADOR = 12;

/**
 * Franja de cifras de la portada: cumplimiento, puntos, escaneados, omitidos.
 *
 * Superficies planas y recuadro fino, sin sombra ni degradado: es la direccion
 * visual del producto y ademas lo unico que sobrevive a una impresora laser.
 * Las que no caben en el ancho util bajan a una segunda fila.
 */
export function dibujarIndicadores(
  doc: PDFKit.PDFDocument,
  indicadores: readonly Indicador[],
): void {
  if (indicadores.length === 0) return;

  const x0 = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const porFila = Math.max(1, Math.floor((ancho + SEPARACION_INDICADOR) / (ANCHO_INDICADOR + SEPARACION_INDICADOR)));
  const filas = Math.ceil(indicadores.length / porFila);
  asegurarEspacioConPie(doc, filas * (ALTO_INDICADOR + SEPARACION_INDICADOR));

  const yInicio = doc.y;
  indicadores.forEach((indicador, posicion) => {
    const columna = posicion % porFila;
    const fila = Math.floor(posicion / porFila);
    const x = x0 + columna * (ANCHO_INDICADOR + SEPARACION_INDICADOR);
    const y = yInicio + fila * (ALTO_INDICADOR + SEPARACION_INDICADOR);

    doc.lineWidth(0.5);
    doc.rect(x, y, ANCHO_INDICADOR, ALTO_INDICADOR).stroke(PALETA.linea);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(PALETA.gris)
      .text(indicador.rotulo.toUpperCase(), x + 6, y + 6, {
        width: ANCHO_INDICADOR - 12,
        lineBreak: false,
      });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(indicador.color ?? PALETA.tinta)
      .text(indicador.cifra, x + 6, y + 16, { width: ANCHO_INDICADOR - 12, lineBreak: false });
    if (indicador.detalle) {
      doc.font('Helvetica').fontSize(6.5).fillColor(indicador.color ?? PALETA.gris)
        .text(indicador.detalle, x + 6, y + ALTO_INDICADOR - 11, {
          width: ANCHO_INDICADOR - 12,
          lineBreak: false,
        });
    }
  });

  doc.x = x0;
  doc.y = yInicio + filas * ALTO_INDICADOR + (filas - 1) * SEPARACION_INDICADOR + 12;
}

// ------------------------------------------------------- filas de la bitacora

export interface LineaBitacora {
  readonly texto: string;
  readonly negrita?: boolean;
  readonly color?: string;
  readonly tamano?: number;
}

export interface FilaBitacora {
  /** "HH:MM" en la zona del recinto; la fecha la da el separador de dia. */
  readonly hora: string;
  readonly evento: string;
  readonly lineas: readonly LineaBitacora[];
  /** Espacio a reservar bajo el texto para la evidencia incrustada. */
  readonly altoExtra?: number;
  /** Filete vertical de alerta a la izquierda del bloque. */
  readonly destacado?: boolean;
}

/** Donde puede dibujar el llamador lo que no es texto (la foto). */
export interface AreaDetalle {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
}

const COL_HORA = 44;
const COL_EVENTO = 96;
const SANGRIA_DETALLE = 8;
const PADDING_FILA = 6;

/**
 * Un bloque de la bitacora: Hora | Evento | Detalle, con el detalle de alto
 * VARIABLE y texto que envuelve.
 *
 * Es lo que `dibujarTabla` no puede hacer: esa usa alto fijo de 17 y
 * `lineBreak:false`, asi que un detalle largo se recorta con `recortar()` en vez
 * de envolverse. Aca el texto de una novedad tiene que salir completo — el libro
 * de novedades es append-only y termina en juicios laborales; un registro
 * cortado a 78 caracteres no sirve como prueba.
 *
 * El bloque se mide ENTERO antes de dibujarse y salta de hoja completo: no se
 * parte un escaneo de su foto ni una novedad a la mitad.
 */
export function dibujarFilaBitacora(doc: PDFKit.PDFDocument, fila: FilaBitacora): AreaDetalle {
  const x0 = doc.page.margins.left;
  const anchoDetalle = anchoUtil(doc) - COL_HORA - COL_EVENTO - SANGRIA_DETALLE;
  const extra = fila.altoExtra ?? 0;

  const altos = fila.lineas.map((linea) => {
    doc.font(linea.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(linea.tamano ?? 8.5);
    return doc.heightOfString(linea.texto, { width: anchoDetalle }) + 1;
  });
  const altoTexto = altos.reduce((suma, alto) => suma + alto, 0);
  const altoTotal = Math.max(altoTexto, 14) + extra + PADDING_FILA;

  asegurarEspacioConPie(doc, altoTotal);
  const y = doc.y;

  if (fila.destacado) {
    // El estado grafico se fija ANTES de construir el trazado: un operador de
    // grosor en medio de un objeto de trazado es invalido segun la especificacion
    // de PDF y hay visores que rechazan el archivo al abrirlo.
    doc.lineWidth(2);
    doc.moveTo(x0 - 4, y).lineTo(x0 - 4, y + altoTotal - PADDING_FILA).stroke(PALETA.alerta);
  }

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETA.tinta)
    .text(fila.hora, x0, y, { width: COL_HORA - 4, lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
    .text(fila.evento, x0 + COL_HORA, y + 1, { width: COL_EVENTO - 6, lineBreak: false });

  const xDetalle = x0 + COL_HORA + COL_EVENTO + SANGRIA_DETALLE;
  let yLinea = y;
  fila.lineas.forEach((linea, indice) => {
    doc.font(linea.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(linea.tamano ?? 8.5)
      .fillColor(linea.color ?? PALETA.tinta)
      .text(linea.texto, xDetalle, yLinea, { width: anchoDetalle });
    yLinea += altos[indice] ?? 0;
  });

  doc.x = x0;
  doc.y = y + altoTotal;
  return { x: xDetalle, y: Math.max(yLinea, y), ancho: anchoDetalle };
}

/**
 * Franja con la fecha, antes de la primera entrada y cada vez que cambia el dia.
 *
 * No es cosmetica: la ronda de referencia es un control nocturno de las 06 hrs y
 * una ronda de noche cruza la medianoche. Sin esta franja, las horas de la
 * bitacora vuelven a empezar sin que nada lo diga.
 */
export function dibujarSeparadorDia(doc: PDFKit.PDFDocument, texto: string): void {
  asegurarEspacioConPie(doc, 24);
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const y = doc.y + 2;
  doc.rect(x, y, ancho, 15).fill(PALETA.zebra);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
    .text(texto.toUpperCase(), x + 6, y + 4, { width: ancho - 12, lineBreak: false });
  doc.x = x;
  doc.y = y + 21;
}

// --------------------------------------------------------- linea de tiempo

export type FormaHito = 'escaneo' | 'escaneo_marcado' | 'tarea' | 'incidente' | 'incidente_grave';

export interface HitoLinea {
  readonly instante: Date;
  readonly forma: FormaHito;
}

export interface DatosLineaTiempo {
  readonly ventana: { readonly desde: Date; readonly hasta: Date };
  readonly ejecucion: { readonly inicio: Date | null; readonly cierre: Date | null };
  readonly hitos: readonly HitoLinea[];
  readonly colorMarca: string;
  readonly timezone: string;
  /** Linea chica bajo el eje; por ejemplo los omitidos, que no tienen hora. */
  readonly nota?: string | null;
}

const ALTO_LINEA_TIEMPO = 44;
const PASOS_ESCALA = [5, 10, 15, 30, 60, 120, 240] as const;

/**
 * Instante -> coordenada, recortada al rango.
 *
 * Pura y afuera del dibujo por la misma razon que `celdaAnexo`: pdfkit dibuja
 * sin quejarse una geometria de ancho negativo o una marca fuera de la caja, y
 * eso solo se ve abriendo el PDF.
 */
export function posicionEnLinea(t0: number, t1: number, ancho: number, t: number): number {
  // Duracion cero: sin esto la division seria por cero y la marca saldria en NaN,
  // que pdfkit escribe en el archivo sin protestar.
  const duracion = t1 - t0;
  if (!Number.isFinite(duracion) || duracion <= 0) return 0;
  const proporcion = (t - t0) / duracion;
  return Math.max(0, Math.min(1, proporcion)) * ancho;
}

/**
 * Cada cuantos minutos poner una etiqueta de hora: el primer paso de la escala
 * que deje 6 etiquetas o menos y al menos 34pt entre ellas. null = ninguna
 * intermedia, y quedan solo las dos de los extremos.
 */
export function pasoDeEtiquetas(duracionMin: number, ancho: number): number | null {
  if (!Number.isFinite(duracionMin) || duracionMin <= 0 || ancho <= 0) return null;
  for (const paso of PASOS_ESCALA) {
    const marcas = Math.floor(duracionMin / paso);
    if (marcas < 1 || marcas > 6) continue;
    if ((paso / duracionMin) * ancho < 34) continue;
    return paso;
  }
  return null;
}

/**
 * Cuando ocurrio la ronda contra la ventana en que estaba prometida.
 *
 * Muestra ademas el hueco: donde se concentraron los escaneos y donde hay 40
 * minutos sin nada. Todo con rect, moveTo/lineTo, circle y polygon: ninguna
 * libreria de graficos.
 *
 * En blanco y negro el rojo y el verde son el mismo gris, asi que el escaneo con
 * marcas se distingue por FORMA —circulo hueco en la punta— y no solo por color.
 */
export function dibujarLineaDeTiempo(doc: PDFKit.PDFDocument, datos: DatosLineaTiempo): void {
  asegurarEspacioConPie(doc, ALTO_LINEA_TIEMPO + 16);
  const x0 = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const yTope = doc.y;
  const yBase = yTope + 26;

  const instantes = datos.hitos
    .map((hito) => new Date(hito.instante).getTime())
    .filter((t) => !Number.isNaN(t));
  const bordes = [
    datos.ventana.desde,
    datos.ventana.hasta,
    datos.ejecucion.inicio,
    datos.ejecucion.cierre,
  ]
    .filter((f): f is Date => f !== null)
    .map((f) => new Date(f).getTime())
    .filter((t) => !Number.isNaN(t));

  const todos = [...instantes, ...bordes];
  const t0 = Math.min(...todos);
  // Ventana de duracion cero: se fuerza un minuto para que la division tenga
  // sentido en vez de repartir todo sobre el mismo pixel.
  const t1 = Math.max(Math.max(...todos), t0 + 60_000);
  const x = (t: number) => x0 + posicionEnLinea(t0, t1, ancho, t);

  // 1. Banda de la ventana programada.
  const xVentanaA = x(new Date(datos.ventana.desde).getTime());
  const xVentanaB = x(new Date(datos.ventana.hasta).getTime());
  doc.rect(xVentanaA, yBase - 5, Math.max(1, xVentanaB - xVentanaA), 10).fill(PALETA.fondoBarra);

  // 2. Banda de ejecucion, en el color de marca del tenant.
  const inicio = datos.ejecucion.inicio;
  if (inicio !== null) {
    const finReal = datos.ejecucion.cierre ?? (instantes.length ? new Date(Math.max(...instantes)) : inicio);
    const xa = x(new Date(inicio).getTime());
    const xb = x(new Date(finReal).getTime());
    doc.rect(xa, yBase - 5, Math.max(1, xb - xa), 10).fill(datos.colorMarca);
  }

  // 3. El eje.
  doc.lineWidth(0.5);
  doc.moveTo(x0, yBase).lineTo(x0 + ancho, yBase).stroke(PALETA.linea);

  // 4-6. Los hitos.
  for (const hito of datos.hitos) {
    const t = new Date(hito.instante).getTime();
    if (Number.isNaN(t)) continue;
    const xh = x(t);
    if (hito.forma === 'escaneo' || hito.forma === 'escaneo_marcado') {
      const marcado = hito.forma === 'escaneo_marcado';
      doc.lineWidth(marcado ? 1.6 : 0.8);
      doc.moveTo(xh, yBase).lineTo(xh, yBase - 8).stroke(marcado ? PALETA.alerta : PALETA.tinta);
      if (marcado) {
        doc.lineWidth(0.8);
        doc.circle(xh, yBase - 10, 2.5).stroke(PALETA.alerta);
      }
    } else if (hito.forma === 'tarea') {
      doc.lineWidth(0.7);
      doc.rect(xh - 2, yBase - 14, 4, 4).stroke(PALETA.tinta);
    } else {
      const grave = hito.forma === 'incidente_grave';
      doc.lineWidth(0.7);
      doc.polygon([xh, yBase + 3], [xh - 3, yBase + 9], [xh + 3, yBase + 9]);
      if (grave) doc.fill(PALETA.alerta);
      else doc.stroke(PALETA.gris);
    }
  }

  // Etiquetas de hora: los extremos siempre, las intermedias segun la escala.
  doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris);
  doc.text(formatearHora(new Date(t0), datos.timezone), x0, yTope, { width: 60, lineBreak: false });
  doc.text(formatearHora(new Date(t1), datos.timezone), x0 + ancho - 60, yTope, {
    width: 60,
    align: 'right',
    lineBreak: false,
  });
  const paso = pasoDeEtiquetas((t1 - t0) / 60_000, ancho);
  if (paso !== null) {
    for (let t = t0 + paso * 60_000; t < t1; t += paso * 60_000) {
      const xe = x(t);
      doc.lineWidth(0.4);
      doc.moveTo(xe, yBase + 0).lineTo(xe, yBase + 3).stroke(PALETA.linea);
      doc.font('Helvetica').fontSize(6.5).fillColor(PALETA.gris)
        .text(formatearHora(new Date(t), datos.timezone), xe - 15, yTope + 9, {
          width: 30,
          align: 'center',
          lineBreak: false,
        });
    }
  }

  if (datos.ejecucion.inicio === null) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
      .text('No iniciada', x0, yBase + 10, { width: ancho, align: 'center', lineBreak: false });
  } else if (datos.nota) {
    doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
      .text(datos.nota, x0, yBase + 12, { width: ancho, lineBreak: false });
  }

  doc.x = x0;
  doc.y = yTope + ALTO_LINEA_TIEMPO + 8;
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
