import { inflateRawSync } from 'node:zlib';

import {
  columnaExcel,
  crc32,
  entero,
  escaparXml,
  fecha,
  fechaHora,
  libroExcelABuffer,
  sanearNombreHoja,
  serialExcel,
  texto,
  type HojaExcel,
} from './excel-xlsx-writer';

/**
 * El escritor de xlsx es el unico codigo de este issue que no se puede revisar
 * leyendolo: o el archivo abre o no abre. Por eso el test DESARMA el ZIP de
 * verdad —cabecera local, CRC, inflate, directorio central— en vez de mirar
 * bytes sueltos. Un CRC mal calculado o un desplazamiento corrido dejan un
 * archivo que Excel declara dañado, y eso no lo ve ninguna asercion de texto.
 */

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_FIN = 0x06054b50;

interface ZipLeido {
  readonly entradas: Map<string, Buffer>;
  readonly inicioDirectorio: number;
  readonly cantidad: number;
}

function leerZip(buffer: Buffer): ZipLeido {
  const entradas = new Map<string, Buffer>();
  let cursor = 0;
  while (cursor + 4 <= buffer.length && buffer.readUInt32LE(cursor) === FIRMA_LOCAL) {
    const crcEsperado = buffer.readUInt32LE(cursor + 14);
    const comprimido = buffer.readUInt32LE(cursor + 18);
    const crudo = buffer.readUInt32LE(cursor + 22);
    const largoNombre = buffer.readUInt16LE(cursor + 26);
    const largoExtra = buffer.readUInt16LE(cursor + 28);
    const nombre = buffer.subarray(cursor + 30, cursor + 30 + largoNombre).toString('utf8');
    const inicio = cursor + 30 + largoNombre + largoExtra;
    const datos = inflateRawSync(buffer.subarray(inicio, inicio + comprimido));
    expect(crc32(datos)).toBe(crcEsperado);
    expect(datos.length).toBe(crudo);
    entradas.set(nombre, datos);
    cursor = inicio + comprimido;
  }

  const fin = buffer.length - 22;
  expect(buffer.readUInt32LE(fin)).toBe(FIRMA_FIN);
  return {
    entradas,
    inicioDirectorio: buffer.readUInt32LE(fin + 16),
    cantidad: buffer.readUInt16LE(fin + 10),
  };
}

const HOJA_MINIMA: HojaExcel = {
  nombre: 'Rondas',
  columnas: [
    { titulo: 'Ronda', ancho: 20 },
    { titulo: 'Fecha', ancho: 12 },
    { titulo: 'Inicio', ancho: 18 },
    { titulo: 'Puntos', ancho: 10 },
  ],
  filas: [
    [
      texto('Ronda «nocturna» <A> & B'),
      fecha('2026-07-06'),
      fechaHora('2026-07-06T22:00:00'),
      entero(12),
    ],
  ],
};

const OPCIONES = { generadoEn: new Date('2026-08-03T12:00:00Z') };

describe('serialExcel', () => {
  it('usa la epoca 1899-12-30 de Excel', () => {
    // 61 es el numero de serie de 1900-03-01, la primera fecha posterior al bug
    // del año bisiesto que Excel arrastra de Lotus.
    expect(serialExcel('1900-03-01')).toBe(61);
    expect(serialExcel('2026-07-06')).toBe(46_209);
  });

  it('convierte la hora a fraccion del dia', () => {
    expect(serialExcel('2026-07-06T12:00:00')).toBe(46_209.5);
    expect(serialExcel('2026-07-06T06:00:00')).toBe(46_209.25);
  });

  it('no corre el dia en la fecha del cambio de horario', () => {
    // El 6 de septiembre de 2026 Chile adelanta el reloj y el dia dura 23 horas.
    // La conversion a numero de serie es aritmetica de calendario en UTC: la
    // hora local ya venia resuelta desde PostgreSQL.
    expect(serialExcel('2026-09-06T00:00:00')).toBe(46_271);
    expect(serialExcel('2026-09-07T00:00:00')).toBe(46_272);
  });

  it('devuelve null en fechas que no existen y en basura', () => {
    expect(serialExcel('2026-02-31')).toBeNull();
    expect(serialExcel('2026-13-01')).toBeNull();
    expect(serialExcel('2026-07-06T25:00:00')).toBeNull();
    expect(serialExcel('ayer')).toBeNull();
    expect(serialExcel('')).toBeNull();
  });
});

describe('escaparXml', () => {
  it('escapa los cinco caracteres del estandar', () => {
    expect(escaparXml('a<b>c&d"e\'f')).toBe('a&lt;b&gt;c&amp;d&quot;e&apos;f');
  });

  it('descarta los caracteres de control que XML 1.0 no admite', () => {
    // Un byte de control en el texto de una novedad deja el libro ilegible.
    expect(escaparXml('porton\u0007 roto\u0007')).toBe('porton roto');
    expect(escaparXml('linea\nsiguiente\ttabulada')).toBe('linea\nsiguiente\ttabulada');
  });

  it('conserva tildes, ñ y emoji', () => {
    expect(escaparXml('Portón dañado 🚨')).toBe('Portón dañado 🚨');
  });
});

describe('columnaExcel', () => {
  it('numera las columnas como la planilla', () => {
    expect(columnaExcel(1)).toBe('A');
    expect(columnaExcel(26)).toBe('Z');
    expect(columnaExcel(27)).toBe('AA');
    expect(columnaExcel(52)).toBe('AZ');
    expect(columnaExcel(53)).toBe('BA');
  });
});

describe('sanearNombreHoja', () => {
  it('quita los caracteres que Excel prohibe y recorta a 31', () => {
    expect(sanearNombreHoja('Novedades [2026]/crit*')).toBe('Novedades  2026  crit');
    expect(sanearNombreHoja('x'.repeat(40))).toHaveLength(31);
    expect(sanearNombreHoja('   ')).toBe('Hoja');
  });
});

describe('escribirLibroExcel', () => {
  it('arma un ZIP integro con las partes que Excel exige', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA], OPCIONES);
    const zip = leerZip(buffer);

    expect([...zip.entradas.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(zip.cantidad).toBe(8);
  });

  it('deja el directorio central justo donde dice el fin de archivo', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA, HOJA_MINIMA], OPCIONES);
    const zip = leerZip(buffer);
    // Un desplazamiento mal acumulado da un archivo que ningun lector abre y
    // que igual pasa cualquier asercion sobre el contenido de las hojas.
    expect(buffer.readUInt32LE(zip.inicioDirectorio)).toBe(0x02014b50);
  });

  it('escribe las fechas como numero de serie con formato, nunca como texto', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA], OPCIONES);
    const hoja = leerZip(buffer).entradas.get('xl/worksheets/sheet1.xml')!.toString('utf8');

    // s="2" es el estilo de fecha y s="3" el de fecha con hora (ver cellXfs).
    expect(hoja).toContain('<c r="B2" s="2"><v>46209</v></c>');
    expect(hoja).toContain('<c r="C2" s="3"><v>46209.916666666664</v></c>');
    // Si la fecha saliera como texto, iria dentro de <is><t>.
    expect(hoja).not.toContain('<is><t xml:space="preserve">2026-07-06');

    const estilos = leerZip(buffer).entradas.get('xl/styles.xml')!.toString('utf8');
    expect(estilos).toContain('<numFmt numFmtId="164" formatCode="dd-mm-yyyy"/>');
    expect(estilos).toContain('numFmtId="165"');
  });

  it('escapa el contenido de las celdas de texto', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA], OPCIONES);
    const hoja = leerZip(buffer).entradas.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(hoja).toContain('Ronda «nocturna» &lt;A&gt; &amp; B');
  });

  it('congela el encabezado y pone autofiltro sobre el rango real', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA], OPCIONES);
    const hoja = leerZip(buffer).entradas.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(hoja).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(hoja).toContain('<autoFilter ref="A1:D2"/>');
    expect(hoja).toContain('<dimension ref="A1:D2"/>');
  });

  it('numera las hojas repetidas en vez de escribir un libro invalido', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA, HOJA_MINIMA], OPCIONES);
    const libro = leerZip(buffer).entradas.get('xl/workbook.xml')!.toString('utf8');
    expect(libro).toContain('<sheet name="Rondas" sheetId="1" r:id="rId1"/>');
    expect(libro).toContain('<sheet name="Rondas 2" sheetId="2" r:id="rId2"/>');
  });

  it('no escribe metadatos de personas en las propiedades del archivo', async () => {
    const buffer = await libroExcelABuffer([HOJA_MINIMA], OPCIONES);
    const app = leerZip(buffer).entradas.get('docProps/app.xml')!.toString('utf8');
    expect(app).toContain('<Application>SentryCore</Application>');
    expect(app).not.toContain('Creator');
    expect(app).not.toContain('lastModifiedBy');
  });

  it('deja vacia la celda de un numero que no se puede representar', async () => {
    const hoja: HojaExcel = {
      nombre: 'Bordes',
      columnas: [{ titulo: 'Valor' }],
      filas: [[entero(Number.NaN)], [entero(null)], [fecha('2026-02-31')]],
    };
    const buffer = await libroExcelABuffer([hoja], OPCIONES);
    const xml = leerZip(buffer).entradas.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(xml).toContain('<row r="2"></row>');
    expect(xml).not.toContain('NaN');
  });
});
