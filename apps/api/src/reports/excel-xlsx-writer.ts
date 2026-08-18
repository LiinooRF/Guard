import { once } from 'node:events';
import { createDeflateRaw } from 'node:zlib';

/**
 * Escritor de libros .xlsx (#136). SIN dependencias nuevas.
 *
 * Un .xlsx es un ZIP con XML adentro (OOXML / SpreadsheetML). Node ya trae el
 * DEFLATE (`node:zlib`), asi que lo unico que falta es el contenedor ZIP y los
 * cuatro XML minimos que Excel exige. Es el mismo criterio con que este repo
 * dibuja las graficas del PDF con primitivas propias en vez de sumar una
 * libreria de charts: la superficie es chica, el formato es estable desde 2007
 * y agregar `exceljs` (~5 MB y decenas de transitivas) para escribir tres
 * tablas no se paga.
 *
 * Lo que SI importa hacer bien, porque es lo que rompe el archivo al abrirlo:
 *
 * 1. Las fechas NO son texto. Van como numero de serie de Excel con formato de
 *    fecha aplicado por estilo. Es el criterio de aceptacion del issue.
 * 2. El numero de serie NO tiene zona horaria. Por eso este archivo recibe la
 *    hora LOCAL DEL RECINTO ya resuelta ('YYYY-MM-DDTHH:MM:SS') y jamas un
 *    Date: convertir aca usaria la zona del servidor, que en un SaaS con
 *    recintos en varias zonas es exactamente el error que se quiere evitar.
 * 3. El XML se escapa siempre. Una novedad escrita por un guardia puede traer
 *    `<`, `&` o comillas, y eso deja el libro ilegible ("formato no valido").
 *
 * El libro se escribe por streaming sobre cualquier Writable: cada parte se
 * comprime a medida que se genera, asi que en memoria nunca esta el XML
 * completo de una hoja.
 */

// ------------------------------------------------------------------ celdas

/**
 * Una celda ya resuelta. `fecha` y `fechaHora` llevan la hora LOCAL DEL
 * RECINTO en texto ISO sin zona; el numero de serie se calcula aca.
 */
export type Celda =
  | { readonly tipo: 'texto'; readonly valor: string }
  | { readonly tipo: 'numero'; readonly valor: number; readonly estilo: number }
  | { readonly tipo: 'fecha'; readonly valor: string }
  | { readonly tipo: 'fechaHora'; readonly valor: string }
  | { readonly tipo: 'vacio' };

export type FilaExcel = readonly Celda[];

/** Indices de `cellXfs` en styles.xml. El orden de ESTILOS_XML manda. */
export const ESTILO = {
  general: 0,
  encabezado: 1,
  fecha: 2,
  fechaHora: 3,
  entero: 4,
  decimal: 5,
} as const;

export const VACIO: Celda = { tipo: 'vacio' };

export function texto(valor: string | null | undefined): Celda {
  if (valor === null || valor === undefined || valor === '') return VACIO;
  return { tipo: 'texto', valor };
}

/** Entero con separador de miles. */
export function entero(valor: number | string | null | undefined): Celda {
  return numeroConEstilo(valor, ESTILO.entero);
}

/** Numero con un decimal (porcentajes de cumplimiento, promedios). */
export function decimal(valor: number | string | null | undefined): Celda {
  return numeroConEstilo(valor, ESTILO.decimal);
}

function numeroConEstilo(valor: number | string | null | undefined, estilo: number): Celda {
  if (valor === null || valor === undefined || valor === '') return VACIO;
  const numero = typeof valor === 'number' ? valor : Number(valor);
  // NaN e Infinity no tienen representacion en el XML de una celda numerica:
  // escribirlos deja el libro ilegible. Van como celda vacia.
  if (!Number.isFinite(numero)) return VACIO;
  return { tipo: 'numero', valor: numero, estilo };
}

/** Fecha sin hora. `valor` es la fecha LOCAL DEL RECINTO ('YYYY-MM-DD'). */
export function fecha(valor: string | null | undefined): Celda {
  if (!valor) return VACIO;
  return { tipo: 'fecha', valor };
}

/**
 * Fecha con hora. `valor` es la hora LOCAL DEL RECINTO en texto sin zona
 * ('YYYY-MM-DDTHH:MM:SS'), tal como la devuelve `to_char(... AT TIME ZONE
 * sites.timezone, ...)`.
 */
export function fechaHora(valor: string | null | undefined): Celda {
  if (!valor) return VACIO;
  return { tipo: 'fechaHora', valor };
}

// ------------------------------------------------------------------- hojas

export interface ColumnaExcel {
  readonly titulo: string;
  /** Ancho en caracteres. Sin valor, Excel usa el ancho por defecto. */
  readonly ancho?: number;
}

export interface HojaExcel {
  /** Maximo 31 caracteres y sin `: \ / ? * [ ]`. Se sanea, no revienta. */
  readonly nombre: string;
  readonly columnas: readonly ColumnaExcel[];
  readonly filas: readonly FilaExcel[];
  /** Fija la fila de titulos al desplazarse. Por defecto, si. */
  readonly congelarEncabezado?: boolean;
  /** Pone el autofiltro sobre los titulos. Por defecto, si. */
  readonly autofiltro?: boolean;
}

export interface OpcionesLibro {
  /** Marca de tiempo de las entradas del ZIP. Fija en los tests. */
  readonly generadoEn?: Date;
  /** Color de la franja de titulos, '#rrggbb'. Es el color de marca del tenant. */
  readonly colorEncabezado?: string;
  /** Color del texto de los titulos, '#rrggbb'. Debe contrastar con el anterior. */
  readonly colorTextoEncabezado?: string;
  /** Va a docProps/app.xml. Nunca lleva datos de personas. */
  readonly aplicacion?: string;
}

// ------------------------------------------------------- fecha -> serie Excel

/**
 * Dia 0 del calendario de Excel. Excel arrastra desde Lotus 1-2-3 el bug de
 * creer que 1900 fue bisiesto, y por eso la epoca efectiva para toda fecha
 * posterior al 1900-03-01 es el 1899-12-30. Este producto no exporta fechas de
 * 1900, asi que no hace falta la correccion del tramo anterior.
 */
const EPOCA_EXCEL_MS = Date.UTC(1899, 11, 30);
const MS_POR_DIA = 86_400_000;
const SEGUNDOS_POR_DIA = 86_400;

const PATRON_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Convierte una hora local (sin zona) al numero de serie de Excel.
 *
 * Se opera con `Date.UTC` a proposito: la aritmetica de calendario en UTC no
 * tiene horario de verano, asi que un 6 de septiembre en Santiago —que dura 23
 * horas— no corre el numero de serie. La zona horaria ya se aplico en
 * PostgreSQL al producir este texto; aca solo se cuentan dias y segundos.
 *
 * Devuelve null si el texto no es una fecha valida: una celda vacia es mejor
 * que un libro que no abre.
 */
export function serialExcel(local: string): number | null {
  const partes = PATRON_LOCAL.exec(local);
  if (!partes) return null;
  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  const hora = partes[4] === undefined ? 0 : Number(partes[4]);
  const minuto = partes[5] === undefined ? 0 : Number(partes[5]);
  const segundo = partes[6] === undefined ? 0 : Number(partes[6]);

  const ms = Date.UTC(anio, mes - 1, dia);
  if (Number.isNaN(ms)) return null;
  // Rebote: `Date.UTC(2026, 1, 31)` no falla, corre al 3 de marzo. Un mes o dia
  // fuera de rango tiene que salir como celda vacia, no como otra fecha.
  const control = new Date(ms);
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== dia ||
    hora > 23 ||
    minuto > 59 ||
    segundo > 59
  ) {
    return null;
  }

  const dias = Math.round((ms - EPOCA_EXCEL_MS) / MS_POR_DIA);
  const fraccion = (hora * 3600 + minuto * 60 + segundo) / SEGUNDOS_POR_DIA;
  return dias + fraccion;
}

// -------------------------------------------------------------------- XML

/**
 * Escapa para XML 1.0 y descarta los caracteres de control que el estandar no
 * admite. Un byte de control colado en el texto de una novedad hace que Excel
 * declare el archivo corrupto, y no hay forma de recuperarlo del lado del
 * usuario.
 */
export function escaparXml(valor: string): string {
  let limpio = '';
  for (const caracter of valor) {
    const codigo = caracter.codePointAt(0) ?? 0;
    const permitido =
      codigo === 0x09 ||
      codigo === 0x0a ||
      codigo === 0x0d ||
      (codigo >= 0x20 && codigo <= 0xd7ff) ||
      (codigo >= 0xe000 && codigo <= 0xfffd) ||
      codigo >= 0x10000;
    if (!permitido) continue;
    if (caracter === '&') limpio += '&amp;';
    else if (caracter === '<') limpio += '&lt;';
    else if (caracter === '>') limpio += '&gt;';
    else if (caracter === '"') limpio += '&quot;';
    else if (caracter === "'") limpio += '&apos;';
    else limpio += caracter;
  }
  return limpio;
}

/** A, B, ... Z, AA, AB... Es 1-indexado como las columnas de la planilla. */
export function columnaExcel(indice: number): string {
  let n = indice;
  let nombre = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    nombre = String.fromCharCode(65 + resto) + nombre;
    n = Math.floor((n - 1) / 26);
  }
  return nombre;
}

/** Sin exponente ni separadores: el XML de una celda numerica es punto decimal. */
function numeroXml(valor: number): string {
  const texto = String(valor);
  if (!texto.includes('e') && !texto.includes('E')) return texto;
  return valor.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

const CARACTERES_PROHIBIDOS_HOJA = /[:\\/?*[\]]/g;

/** Excel rechaza el libro entero si un nombre de hoja pasa de 31 o trae `[]:*?/\`. */
export function sanearNombreHoja(nombre: string): string {
  const limpio = nombre.replace(CARACTERES_PROHIBIDOS_HOJA, ' ').trim().slice(0, 31);
  return limpio === '' ? 'Hoja' : limpio;
}

function normalizarColor(color: string | undefined, porDefecto: string): string {
  const valor = (color ?? porDefecto).trim();
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(valor);
  return `FF${(hex?.[1] ?? porDefecto.slice(1)).toUpperCase()}`;
}

// ------------------------------------------------------------- partes fijas

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_HOJA = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function contentTypes(cantidadHojas: number): string {
  const hojas = Array.from(
    { length: cantidadHojas },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    hojas +
    `<Override PartName="/docProps/core.xml" ` +
    `ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

const RELS_RAIZ =
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${NS_REL_DOC}/officeDocument" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" ` +
  `Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ` +
  `Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${NS_REL_DOC}/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

function workbookXml(nombres: readonly string[]): string {
  const hojas = nombres
    .map(
      (nombre, i) =>
        `<sheet name="${escaparXml(nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');
  return (
    `${XML_DECL}<workbook xmlns="${NS_HOJA}" xmlns:r="${NS_REL_DOC}">` +
    `<workbookPr date1904="false"/>` +
    `<sheets>${hojas}</sheets>` +
    `</workbook>`
  );
}

function workbookRels(cantidadHojas: number): string {
  const hojas = Array.from(
    { length: cantidadHojas },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${NS_REL_DOC}/worksheet" ` +
      `Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    hojas +
    `<Relationship Id="rId${cantidadHojas + 1}" Type="${NS_REL_DOC}/styles" Target="styles.xml"/>` +
    `</Relationships>`
  );
}

/**
 * Hoja de estilos.
 *
 * Los formatos de fecha se declaran como numFmt propios (id >= 164) en vez de
 * usar los incorporados 14 y 22: esos se muestran segun la configuracion
 * regional de quien abre el archivo, y el informe de una empresa chilena tiene
 * que verse dd-mm-aaaa tambien si el gerente lo abre con Excel en ingles.
 *
 * Los dos primeros `fill` (none y gray125) son obligatorios: Excel los da por
 * sentado y sin ellos declara el libro dañado.
 */
function stylesXml(colorFondo: string, colorTexto: string): string {
  return (
    `${XML_DECL}<styleSheet xmlns="${NS_HOJA}">` +
    `<numFmts count="4">` +
    `<numFmt numFmtId="164" formatCode="dd-mm-yyyy"/>` +
    `<numFmt numFmtId="165" formatCode="dd-mm-yyyy\\ hh:mm"/>` +
    `<numFmt numFmtId="166" formatCode="#,##0"/>` +
    `<numFmt numFmtId="167" formatCode="#,##0.0"/>` +
    `</numFmts>` +
    `<fonts count="2">` +
    `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><color rgb="${colorTexto}"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid">` +
    `<fgColor rgb="${colorFondo}"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" ` +
    `applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

function coreXml(generadoEn: Date): string {
  const instante = generadoEn.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `${XML_DECL}<cp:coreProperties ` +
    `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${instante}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${instante}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

/**
 * Sin autor ni "ultimo que guardo": son metadatos de PERSONAS y este archivo
 * sale del servidor hacia el correo del cliente. Solo el nombre del sistema.
 */
function appXml(aplicacion: string): string {
  return (
    `${XML_DECL}<Properties ` +
    `xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>${escaparXml(aplicacion)}</Application>` +
    `</Properties>`
  );
}

// -------------------------------------------------------------------- hoja

function* hojaXml(hoja: HojaExcel): Generator<string> {
  const columnas = hoja.columnas;
  const ultimaColumna = columnaExcel(Math.max(1, columnas.length));
  const ultimaFila = hoja.filas.length + 1;
  const congelar = hoja.congelarEncabezado !== false;
  const autofiltro = hoja.autofiltro !== false && columnas.length > 0;

  yield `${XML_DECL}<worksheet xmlns="${NS_HOJA}">`;
  yield `<dimension ref="A1:${ultimaColumna}${ultimaFila}"/>`;
  yield '<sheetViews><sheetView workbookViewId="0">';
  if (congelar) {
    yield '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
    yield '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  }
  yield '</sheetView></sheetViews>';
  yield '<sheetFormatPr defaultRowHeight="15"/>';

  const conAncho = columnas
    .map((columna, i) => ({ columna, i }))
    .filter((entrada) => entrada.columna.ancho !== undefined);
  if (conAncho.length > 0) {
    yield '<cols>';
    for (const { columna, i } of conAncho) {
      yield `<col min="${i + 1}" max="${i + 1}" width="${columna.ancho}" customWidth="1"/>`;
    }
    yield '</cols>';
  }

  yield '<sheetData>';
  if (columnas.length > 0) {
    yield `<row r="1" ht="22" customHeight="1">`;
    for (let c = 0; c < columnas.length; c += 1) {
      const referencia = `${columnaExcel(c + 1)}1`;
      yield `<c r="${referencia}" s="${ESTILO.encabezado}" t="inlineStr">` +
        `<is><t xml:space="preserve">${escaparXml(columnas[c]!.titulo)}</t></is></c>`;
    }
    yield '</row>';
  }
  for (let f = 0; f < hoja.filas.length; f += 1) {
    const numeroFila = f + 2;
    yield `<row r="${numeroFila}">`;
    const fila = hoja.filas[f]!;
    for (let c = 0; c < fila.length; c += 1) {
      const celda = celdaXml(fila[c]!, `${columnaExcel(c + 1)}${numeroFila}`);
      if (celda !== '') yield celda;
    }
    yield '</row>';
  }
  yield '</sheetData>';

  if (autofiltro) yield `<autoFilter ref="A1:${ultimaColumna}${ultimaFila}"/>`;
  yield '</worksheet>';
}

function celdaXml(celda: Celda, referencia: string): string {
  switch (celda.tipo) {
    case 'vacio':
      // Una celda sin `<c>` es una celda vacia de verdad: no ocupa bytes y no
      // deja una cadena vacia que despues rompe los filtros y los promedios.
      return '';
    case 'texto':
      return (
        `<c r="${referencia}" t="inlineStr"><is><t xml:space="preserve">` +
        `${escaparXml(celda.valor)}</t></is></c>`
      );
    case 'numero':
      return `<c r="${referencia}" s="${celda.estilo}"><v>${numeroXml(celda.valor)}</v></c>`;
    case 'fecha':
    case 'fechaHora': {
      const serie = serialExcel(celda.valor);
      if (serie === null) return '';
      const estilo = celda.tipo === 'fecha' ? ESTILO.fecha : ESTILO.fechaHora;
      return `<c r="${referencia}" s="${estilo}"><v>${numeroXml(serie)}</v></c>`;
    }
  }
}

// --------------------------------------------------------------------- ZIP

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let valor = i;
    for (let bit = 0; bit < 8; bit += 1) {
      valor = valor & 1 ? 0xedb88320 ^ (valor >>> 1) : valor >>> 1;
    }
    tabla[i] = valor >>> 0;
  }
  return tabla;
})();

/** CRC-32 incremental (el que exige el formato ZIP). */
export function crc32(datos: Buffer, previo = 0): number {
  let crc = ~previo >>> 0;
  for (const byte of datos) {
    crc = (TABLA_CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return ~crc >>> 0;
}

interface EntradaZip {
  readonly nombre: string;
  readonly crc: number;
  readonly comprimido: number;
  readonly crudo: number;
  readonly desplazamiento: number;
}

/** Fecha y hora en el formato de 16 bits de MS-DOS que usa el ZIP. */
function fechaDos(fecha: Date): { hora: number; dia: number } {
  const anio = Math.max(1980, fecha.getUTCFullYear());
  return {
    hora:
      (fecha.getUTCHours() << 11) |
      (fecha.getUTCMinutes() << 5) |
      Math.floor(fecha.getUTCSeconds() / 2),
    dia: ((anio - 1980) << 9) | ((fecha.getUTCMonth() + 1) << 5) | fecha.getUTCDate(),
  };
}

async function escribir(destino: NodeJS.WritableStream, datos: Buffer): Promise<void> {
  if (!destino.write(datos)) await once(destino, 'drain');
}

const LIMITE_ZIP = 0xffff_ffff;

async function agregarEntrada(
  destino: NodeJS.WritableStream,
  nombre: string,
  contenido: Iterable<string>,
  fechaArchivo: Date,
  desplazamiento: number,
): Promise<EntradaZip> {
  const deflate = createDeflateRaw({ level: 6 });
  const comprimido: Buffer[] = [];
  deflate.on('data', (trozo: Buffer) => comprimido.push(trozo));
  const terminado = once(deflate, 'end');

  let crc = 0;
  let crudo = 0;
  for (const parte of contenido) {
    const bytes = Buffer.from(parte, 'utf8');
    crc = crc32(bytes, crc);
    crudo += bytes.length;
    if (!deflate.write(bytes)) await once(deflate, 'drain');
  }
  deflate.end();
  await terminado;

  const cuerpo = Buffer.concat(comprimido);
  if (crudo > LIMITE_ZIP || cuerpo.length > LIMITE_ZIP) {
    // ZIP64 no esta implementado: mejor un error claro que un archivo que
    // ningun Excel abre.
    throw new Error('La hoja supera los 4 GB y este escritor no implementa ZIP64');
  }

  const nombreBytes = Buffer.from(nombre, 'utf8');
  const { hora, dia } = fechaDos(fechaArchivo);
  const cabecera = Buffer.alloc(30 + nombreBytes.length);
  cabecera.writeUInt32LE(0x04034b50, 0);
  cabecera.writeUInt16LE(20, 4); // version minima
  cabecera.writeUInt16LE(0, 6); // sin banderas: los nombres son ASCII
  cabecera.writeUInt16LE(8, 8); // deflate
  cabecera.writeUInt16LE(hora, 10);
  cabecera.writeUInt16LE(dia, 12);
  cabecera.writeUInt32LE(crc, 14);
  cabecera.writeUInt32LE(cuerpo.length, 18);
  cabecera.writeUInt32LE(crudo, 22);
  cabecera.writeUInt16LE(nombreBytes.length, 26);
  cabecera.writeUInt16LE(0, 28); // sin campo extra
  nombreBytes.copy(cabecera, 30);

  await escribir(destino, cabecera);
  await escribir(destino, cuerpo);

  return { nombre, crc, comprimido: cuerpo.length, crudo, desplazamiento };
}

function directorioCentral(entradas: readonly EntradaZip[], fechaArchivo: Date): Buffer {
  const { hora, dia } = fechaDos(fechaArchivo);
  const partes: Buffer[] = [];
  for (const entrada of entradas) {
    const nombreBytes = Buffer.from(entrada.nombre, 'utf8');
    const registro = Buffer.alloc(46 + nombreBytes.length);
    registro.writeUInt32LE(0x02014b50, 0);
    registro.writeUInt16LE(20, 4); // creado por
    registro.writeUInt16LE(20, 6); // version minima
    registro.writeUInt16LE(0, 8);
    registro.writeUInt16LE(8, 10);
    registro.writeUInt16LE(hora, 12);
    registro.writeUInt16LE(dia, 14);
    registro.writeUInt32LE(entrada.crc, 16);
    registro.writeUInt32LE(entrada.comprimido, 20);
    registro.writeUInt32LE(entrada.crudo, 24);
    registro.writeUInt16LE(nombreBytes.length, 28);
    registro.writeUInt16LE(0, 30); // extra
    registro.writeUInt16LE(0, 32); // comentario
    registro.writeUInt16LE(0, 34); // disco
    registro.writeUInt16LE(0, 36); // atributos internos
    registro.writeUInt32LE(0, 38); // atributos externos
    registro.writeUInt32LE(entrada.desplazamiento, 42);
    nombreBytes.copy(registro, 46);
    partes.push(registro);
  }
  return Buffer.concat(partes);
}

function finDirectorio(cantidad: number, tamanoDirectorio: number, inicio: number): Buffer {
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(cantidad, 8);
  fin.writeUInt16LE(cantidad, 10);
  fin.writeUInt32LE(tamanoDirectorio, 12);
  fin.writeUInt32LE(inicio, 16);
  fin.writeUInt16LE(0, 20);
  return fin;
}

// ------------------------------------------------------------------- libro

/**
 * Escribe el libro completo sobre `destino`. No lo cierra: quien abrio el
 * stream decide cuando termina (la respuesta HTTP la cierra el controlador).
 */
export async function escribirLibroExcel(
  destino: NodeJS.WritableStream,
  hojas: readonly HojaExcel[],
  opciones: OpcionesLibro = {},
): Promise<void> {
  if (hojas.length === 0) throw new Error('Un libro necesita al menos una hoja');

  const nombres = nombresUnicos(hojas.map((hoja) => hoja.nombre));
  const generadoEn = opciones.generadoEn ?? new Date();
  const colorFondo = normalizarColor(opciones.colorEncabezado, '#1f3b73');
  const colorTexto = normalizarColor(opciones.colorTextoEncabezado, '#ffffff');

  const partes: Array<{ nombre: string; contenido: Iterable<string> }> = [
    { nombre: '[Content_Types].xml', contenido: [contentTypes(hojas.length)] },
    { nombre: '_rels/.rels', contenido: [RELS_RAIZ] },
    { nombre: 'docProps/core.xml', contenido: [coreXml(generadoEn)] },
    { nombre: 'docProps/app.xml', contenido: [appXml(opciones.aplicacion ?? 'SentryCore')] },
    { nombre: 'xl/workbook.xml', contenido: [workbookXml(nombres)] },
    { nombre: 'xl/_rels/workbook.xml.rels', contenido: [workbookRels(hojas.length)] },
    { nombre: 'xl/styles.xml', contenido: [stylesXml(colorFondo, colorTexto)] },
    ...hojas.map((hoja, i) => ({
      nombre: `xl/worksheets/sheet${i + 1}.xml`,
      contenido: { [Symbol.iterator]: () => hojaXml(hoja) } as Iterable<string>,
    })),
  ];

  const entradas: EntradaZip[] = [];
  let desplazamiento = 0;
  for (const parte of partes) {
    const entrada = await agregarEntrada(
      destino,
      parte.nombre,
      parte.contenido,
      generadoEn,
      desplazamiento,
    );
    entradas.push(entrada);
    desplazamiento += 30 + Buffer.byteLength(entrada.nombre, 'utf8') + entrada.comprimido;
  }

  const directorio = directorioCentral(entradas, generadoEn);
  await escribir(destino, directorio);
  await escribir(destino, finDirectorio(entradas.length, directorio.length, desplazamiento));
}

/** El libro en memoria. Para tests y para adjuntarlo a un correo. */
export async function libroExcelABuffer(
  hojas: readonly HojaExcel[],
  opciones: OpcionesLibro = {},
): Promise<Buffer> {
  const trozos: Buffer[] = [];
  const destino = {
    write(datos: Buffer): boolean {
      trozos.push(Buffer.from(datos));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  await escribirLibroExcel(destino, hojas, opciones);
  return Buffer.concat(trozos);
}

/** Excel no admite dos hojas con el mismo nombre: se numeran. */
function nombresUnicos(nombres: readonly string[]): string[] {
  const usados = new Set<string>();
  return nombres.map((original) => {
    const base = sanearNombreHoja(original);
    let candidato = base;
    let sufijo = 2;
    while (usados.has(candidato.toLowerCase())) {
      const recorte = base.slice(0, 31 - String(sufijo).length - 1);
      candidato = `${recorte} ${sufijo}`;
      sufijo += 1;
    }
    usados.add(candidato.toLowerCase());
    return candidato;
  });
}
