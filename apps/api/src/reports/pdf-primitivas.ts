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

export const ANCHO_INDICADOR = 96;
const SEPARACION_INDICADOR = 12;
const PADDING_INDICADOR = 6;
/** Aire entre la ultima linea del detalle y el borde de abajo. */
const PADDING_INFERIOR_INDICADOR = 4;
/** Donde arranca la cifra dentro de la ficha, y lo que ocupa impresa. */
const Y_CIFRA_INDICADOR = 16;
const TAM_CIFRA_INDICADOR = 20;
const ALTO_CIFRA_INDICADOR = 19;
/** Alto historico de la ficha; es el piso, no el techo. */
const ALTO_MIN_INDICADOR = 46;
/** Cuerpos que puede tomar el detalle, del preferido al ultimo recurso. */
const TAMANOS_DETALLE = [6.5, 6, 5.5, 5] as const;

export interface DetalleIndicador {
  readonly tamano: number;
  readonly lineas: readonly string[];
}

/**
 * Acomoda el detalle de una ficha DENTRO de su recuadro, midiendolo.
 *
 * El defecto que ataja: "Sobre el umbral · umbral 70%" mide 85,8pt en cuerpo 6,5
 * contra los 84pt utiles de la ficha, y "BAJO EL UMBRAL · umbral 70%" mide 95,7.
 * pdfkit ENVUELVE igual aunque se le pase `lineBreak:false` —comprobado en el
 * flujo del PDF: dos bloques BT/ET— asi que la segunda linea caia 4pt por debajo
 * del borde inferior. No dependia de los datos: pasaba con 0%, con 89% y con
 * 100%, o sea en todos los informes.
 *
 * Se prefiere partir por el separador propio del texto antes que achicar la
 * letra: dos lineas en cuerpo 6,5 se leen impresas; una linea en cuerpo 5 no.
 * Se exporta para poder comprobar contra las metricas reales de la fuente que lo
 * que se va a escribir cabe, que es lo unico que este arreglo promete.
 */
export function ajustarDetalleIndicador(
  doc: PDFKit.PDFDocument,
  texto: string,
  ancho: number,
): DetalleIndicador {
  const mide = (linea: string, tamano: number): number => {
    doc.font('Helvetica').fontSize(tamano);
    return doc.widthOfString(linea);
  };

  const candidatos = particionesDeDetalle(texto);
  for (const tamano of TAMANOS_DETALLE) {
    for (const lineas of candidatos) {
      if (lineas.every((linea) => mide(linea, tamano) <= ancho)) return { tamano, lineas };
    }
  }

  // Ni partido ni en el cuerpo mas chico entra: se recorta MIDIENDO. Un texto
  // recortado con elipsis se entiende; uno escrito fuera del recuadro se lee
  // como un informe roto.
  const tamano = TAMANOS_DETALLE[TAMANOS_DETALLE.length - 1]!;
  const ultimo = candidatos[candidatos.length - 1]!;
  return {
    tamano,
    lineas: ultimo.map((linea) => recortarAlAncho(doc, linea, ancho, tamano)),
  };
}

/** Formas de partir el detalle, de la mas legible a la menos. */
function particionesDeDetalle(texto: string): string[][] {
  const particiones: string[][] = [[texto]];
  const partes = texto.split(' · ');
  for (let corte = 1; corte < partes.length; corte += 1) {
    particiones.push([partes.slice(0, corte).join(' · '), partes.slice(corte).join(' · ')]);
  }
  const palabras = texto.split(' ');
  if (palabras.length > 1) {
    const mitad = Math.ceil(palabras.length / 2);
    particiones.push([palabras.slice(0, mitad).join(' '), palabras.slice(mitad).join(' ')]);
  }
  return particiones;
}

/** Recorte por ancho REAL de la fuente, no por cantidad de caracteres. */
function recortarAlAncho(
  doc: PDFKit.PDFDocument,
  texto: string,
  ancho: number,
  tamano: number,
): string {
  doc.font('Helvetica').fontSize(tamano);
  if (doc.widthOfString(texto) <= ancho) return texto;
  let corte = texto.length;
  while (corte > 1 && doc.widthOfString(`${texto.slice(0, corte - 1)}…`) > ancho) corte -= 1;
  return `${texto.slice(0, Math.max(1, corte - 1))}…`;
}

/**
 * Franja de cifras de la portada: cumplimiento, puntos, escaneados, omitidos.
 *
 * Superficies planas y recuadro fino, sin sombra ni degradado: es la direccion
 * visual del producto y ademas lo unico que sobrevive a una impresora laser.
 * Las que no caben en el ancho util bajan a una segunda fila.
 *
 * El alto de la ficha se DERIVA de lo que hay que escribir adentro —el detalle
 * ya medido— en vez de ser una constante que el texto desborda. Todas las fichas
 * comparten el alto para que la franja siga leyendose como una sola fila.
 */
export function dibujarIndicadores(
  doc: PDFKit.PDFDocument,
  indicadores: readonly Indicador[],
): void {
  if (indicadores.length === 0) return;

  const x0 = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const anchoTexto = ANCHO_INDICADOR - PADDING_INDICADOR * 2;
  const porFila = Math.max(1, Math.floor((ancho + SEPARACION_INDICADOR) / (ANCHO_INDICADOR + SEPARACION_INDICADOR)));
  const filas = Math.ceil(indicadores.length / porFila);

  const detalles = indicadores.map((indicador) =>
    indicador.detalle ? ajustarDetalleIndicador(doc, indicador.detalle, anchoTexto) : null,
  );
  const altoDetalle = detalles.reduce(
    (mayor, detalle) => Math.max(mayor, detalle ? altoDeDetalle(doc, detalle) : 0),
    0,
  );
  const altoFicha = Math.max(
    ALTO_MIN_INDICADOR,
    Y_CIFRA_INDICADOR + ALTO_CIFRA_INDICADOR + altoDetalle + PADDING_INFERIOR_INDICADOR,
  );
  asegurarEspacioConPie(doc, filas * (altoFicha + SEPARACION_INDICADOR));

  const yInicio = doc.y;
  indicadores.forEach((indicador, posicion) => {
    const columna = posicion % porFila;
    const fila = Math.floor(posicion / porFila);
    const x = x0 + columna * (ANCHO_INDICADOR + SEPARACION_INDICADOR);
    const y = yInicio + fila * (altoFicha + SEPARACION_INDICADOR);

    doc.lineWidth(0.5);
    doc.rect(x, y, ANCHO_INDICADOR, altoFicha).stroke(PALETA.linea);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(PALETA.gris)
      .text(indicador.rotulo.toUpperCase(), x + PADDING_INDICADOR, y + PADDING_INDICADOR, {
        width: anchoTexto,
        lineBreak: false,
      });
    doc.font('Helvetica-Bold').fontSize(TAM_CIFRA_INDICADOR)
      .fillColor(indicador.color ?? PALETA.tinta)
      .text(indicador.cifra, x + PADDING_INDICADOR, y + Y_CIFRA_INDICADOR, {
        width: anchoTexto,
        lineBreak: false,
      });

    const detalle = detalles[posicion];
    if (!detalle) return;
    doc.font('Helvetica').fontSize(detalle.tamano);
    const alto = doc.currentLineHeight();
    const yDetalle = y + altoFicha - PADDING_INFERIOR_INDICADOR - alto * detalle.lineas.length;
    detalle.lineas.forEach((linea, indice) => {
      doc.font('Helvetica').fontSize(detalle.tamano).fillColor(indicador.color ?? PALETA.gris)
        .text(linea, x + PADDING_INDICADOR, yDetalle + indice * alto, {
          width: anchoTexto,
          lineBreak: false,
        });
    });
  });

  doc.x = x0;
  doc.y = yInicio + filas * altoFicha + (filas - 1) * SEPARACION_INDICADOR + 12;
}

function altoDeDetalle(doc: PDFKit.PDFDocument, detalle: DetalleIndicador): number {
  doc.font('Helvetica').fontSize(detalle.tamano);
  return doc.currentLineHeight() * detalle.lineas.length;
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

/**
 * Las tres bandas de la linea de tiempo, cada una con su alto propio.
 *
 * Antes se solapaban POR CONSTRUCCION: las etiquetas de hora intermedias se
 * escribian a yTope+9 con un alto de ~7,5pt y las marcas de tarea se dibujaban a
 * yBase-14 = yTope+12. Los dos rangos se cruzan siempre, con cualquier duracion
 * de ronda. Separarlas en bandas declaradas es lo que impide que vuelva a pasar
 * al mover un numero suelto.
 *
 *   yTope                      etiquetas de hora (extremos e intermedias)
 *   yTope + BANDA_ETIQUETAS    marcas sobre el eje (escaneos y tareas)
 *   yBase                      el eje
 *   yBase + ...                marcas de hora y novedades bajo el eje
 *   yBase + Y_NOTA             las notas
 */
const BANDA_ETIQUETAS = 10;
const BANDA_HITOS = 18;
/** Marca de tarea: cuadrado sobre el eje, dentro de BANDA_HITOS. */
const Y_MARCA_TAREA = -16;
const Y_MARCA_ESCANEO = -8;
const Y_CIRCULO_MARCADO = -10;
/** Bajo el eje: primero la marquita de la escala, despues los triangulos. */
const ALTO_TICK = 2;
const Y_INCIDENTE = 4;
const Y_NOTA = 13;
const ALTO_NOTA = 8;
const ALTO_LINEA_TIEMPO = BANDA_ETIQUETAS + BANDA_HITOS + Y_NOTA + ALTO_NOTA * 2;
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

export interface EscalaLinea {
  readonly t0: number;
  readonly t1: number;
  /** true cuando la ventana programada se sale del tramo dibujado. */
  readonly ventanaRecortada: boolean;
}

/**
 * El rango horizontal de la linea: LO QUE OCURRIO, no lo que estaba programado.
 *
 * El defecto que ataja: la escala se armaba sobre el minimo y el maximo de
 * ventana + ejecucion + hitos, asi que una ronda de 13 minutos dentro de un
 * turno de 22:00 a 06:00 repartia sus 15 hitos sobre 14 de los 515pt del ancho
 * util —el 2,7%— y salian encimados entre si y encima de la etiqueta de hora. La
 * ventana programada ya esta escrita con todas sus letras en la ficha de la
 * portada; lo que la linea tiene que mostrar es el recorrido.
 *
 * La ventana se sigue dibujando como banda de fondo, recortada al tramo visible
 * (posicionEnLinea acota a [0, ancho]), y `ventanaRecortada` avisa que la banda
 * llega hasta el borde porque se la corto y no porque ahi termine.
 *
 * Cuando no ocurrio NADA —ronda no iniciada, sin hitos— no hay recorrido que
 * mostrar y se cae a la ventana: es lo unico que se sabe de esa ronda.
 */
export function escalaLineaDeTiempo(datos: DatosLineaTiempo): EscalaLinea {
  const instantes = datos.hitos
    .map((hito) => new Date(hito.instante).getTime())
    .filter((t) => !Number.isNaN(t));
  const ejecucion = [datos.ejecucion.inicio, datos.ejecucion.cierre]
    .filter((f): f is Date => f !== null)
    .map((f) => new Date(f).getTime())
    .filter((t) => !Number.isNaN(t));
  const ventana = [datos.ventana.desde, datos.ventana.hasta]
    .filter((f): f is Date => f !== null && f !== undefined)
    .map((f) => new Date(f).getTime())
    .filter((t) => !Number.isNaN(t));

  const ocurrido = [...instantes, ...ejecucion];
  const base = ocurrido.length > 0 ? ocurrido : ventana;
  if (base.length === 0) {
    // Ni ventana valida: se devuelve un minuto para no dividir por cero mas
    // abajo. pdfkit dibuja un NaN en el archivo sin protestar.
    const ahora = Date.now();
    return { t0: ahora, t1: ahora + 60_000, ventanaRecortada: false };
  }

  const t0 = Math.min(...base);
  // Duracion cero: se fuerza un minuto para que la division tenga sentido en vez
  // de repartir todo sobre el mismo pixel.
  const t1 = Math.max(Math.max(...base), t0 + 60_000);
  const ventanaRecortada =
    ventana.length > 0 && (Math.min(...ventana) < t0 || Math.max(...ventana) > t1);
  return { t0, t1, ventanaRecortada };
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
  const yBase = yTope + BANDA_ETIQUETAS + BANDA_HITOS;

  const { t0, t1, ventanaRecortada } = escalaLineaDeTiempo(datos);
  const instantes = datos.hitos
    .map((hito) => new Date(hito.instante).getTime())
    .filter((t) => !Number.isNaN(t));
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

  // 4-6. Los hitos, todos dentro de BANDA_HITOS salvo las novedades, que van
  // bajo el eje para no confundirse con un escaneo.
  for (const hito of datos.hitos) {
    const t = new Date(hito.instante).getTime();
    if (Number.isNaN(t)) continue;
    const xh = x(t);
    if (hito.forma === 'escaneo' || hito.forma === 'escaneo_marcado') {
      const marcado = hito.forma === 'escaneo_marcado';
      doc.lineWidth(marcado ? 1.6 : 0.8);
      doc.moveTo(xh, yBase).lineTo(xh, yBase + Y_MARCA_ESCANEO)
        .stroke(marcado ? PALETA.alerta : PALETA.tinta);
      if (marcado) {
        doc.lineWidth(0.8);
        doc.circle(xh, yBase + Y_CIRCULO_MARCADO, 2.5).stroke(PALETA.alerta);
      }
    } else if (hito.forma === 'tarea') {
      doc.lineWidth(0.7);
      doc.rect(xh - 2, yBase + Y_MARCA_TAREA, 4, 4).stroke(PALETA.tinta);
    } else {
      const grave = hito.forma === 'incidente_grave';
      doc.lineWidth(0.7);
      doc.polygon(
        [xh, yBase + Y_INCIDENTE],
        [xh - 3, yBase + Y_INCIDENTE + 6],
        [xh + 3, yBase + Y_INCIDENTE + 6],
      );
      if (grave) doc.fill(PALETA.alerta);
      else doc.stroke(PALETA.gris);
    }
  }

  // Etiquetas de hora: los extremos siempre, las intermedias segun la escala.
  // TODAS en la banda de arriba: la marquita bajo el eje es la que las ata a su
  // instante, y asi ninguna cae encima de un hito.
  const horaInicial = formatearHora(new Date(t0), datos.timezone);
  const horaFinal = formatearHora(new Date(t1), datos.timezone);
  doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris);
  const anchoInicial = doc.widthOfString(horaInicial);
  const anchoFinal = doc.widthOfString(horaFinal);
  doc.text(horaInicial, x0, yTope, { width: 60, lineBreak: false });
  doc.text(horaFinal, x0 + ancho - 60, yTope, {
    width: 60,
    align: 'right',
    lineBreak: false,
  });

  const paso = pasoDeEtiquetas((t1 - t0) / 60_000, ancho);
  if (paso !== null) {
    doc.font('Helvetica').fontSize(6.5);
    for (let t = t0 + paso * 60_000; t < t1; t += paso * 60_000) {
      const xe = x(t);
      doc.lineWidth(0.4);
      doc.moveTo(xe, yBase).lineTo(xe, yBase + ALTO_TICK).stroke(PALETA.linea);

      // La etiqueta se omite cuando pisaria a la del extremo: dos horas
      // superpuestas no se leen ni son dos datos, son una mancha.
      const etiqueta = formatearHora(new Date(t), datos.timezone);
      doc.font('Helvetica').fontSize(6.5);
      const medio = doc.widthOfString(etiqueta) / 2;
      if (xe - medio < x0 + anchoInicial + 4) continue;
      if (xe + medio > x0 + ancho - anchoFinal - 4) continue;
      doc.fillColor(PALETA.gris)
        .text(etiqueta, xe - 15, yTope, { width: 30, align: 'center', lineBreak: false });
    }
  }

  // Notas, una por linea y siempre bajo todo lo demas.
  const notas: string[] = [];
  if (datos.ejecucion.inicio === null) notas.push('Ronda no iniciada: no hay recorrido que mostrar');
  else if (ventanaRecortada) {
    notas.push(
      `La escala muestra el tramo ejecutado (${horaInicial}—${horaFinal});` +
        ` la ventana programada era ${formatearHora(new Date(datos.ventana.desde), datos.timezone)}` +
        `—${formatearHora(new Date(datos.ventana.hasta), datos.timezone)}.`,
    );
  }
  if (datos.nota) notas.push(datos.nota);
  notas.slice(0, 2).forEach((nota, indice) => {
    doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
      .text(nota, x0, yBase + Y_NOTA + indice * ALTO_NOTA, { width: ancho, lineBreak: false });
  });

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
