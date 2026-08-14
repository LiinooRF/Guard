import { patrolRulesSchema } from '@voxia/shared';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import PDFDocument from 'pdfkit';

import {
  construirInformeRonda,
  type EncabezadoRondaRow,
  type EntradaModelo,
  type FotoRow,
  type IncidenteRow,
  type InformeRonda,
  type PuntoEsperadoRow,
  type ScanRow,
  type TareaRow,
} from './patrol-report.model';
import {
  dibujarCuerpo,
  instalarPieDePagina,
  type OpcionesRender,
} from './patrol-report.renderer';
import type { MarcaDocumento } from './pdf-primitivas';

/**
 * El dibujo se prueba de tres maneras y ninguna mira pixeles: que pdfkit acepte
 * lo que le mandamos (un PDF que abre y termina bien), QUE TEXTO se escribio
 * —capturando las llamadas a doc.text, porque el contenido del PDF va
 * comprimido y no se puede leer del binario— y que el cursor quede donde
 * corresponde para que la seccion siguiente no se escriba encima.
 *
 * Lo que este archivo NO puede probar es como se ve impreso. Eso se revisa
 * abriendo un informe de verdad; aca solo se ataja que no reviente y que lo que
 * el issue pidio decir quede efectivamente dicho.
 */

const UMBRAL = patrolRulesSchema.parse({}).complianceThreshold;

const MARCA: MarcaDocumento = {
  displayName: 'Vigilancia Austral Ltda',
  logoUri: null,
  primaryColor: '#7a1f1f',
  mailFooter: 'Vigilancia Austral Ltda · Región de Los Lagos',
};

const RONDA: EncabezadoRondaRow = {
  id: 'patrol-id',
  status: 'completada',
  scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
  scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
  started_at: new Date('2026-07-30T22:05:00-04:00'),
  closed_at: new Date('2026-07-31T05:40:00-04:00'),
  compliance_pct: '100.00',
  site_id: 'site-1',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: '6to Control Nocturno 06 hrs.',
  guard_name: 'Juan Soto',
};

const PUNTOS: PuntoEsperadoRow[] = [
  {
    position: '1',
    id: 'cp-1',
    name: 'Acceso principal',
    kind: 'normal',
    is_closing_point: false,
    instructions: 'Revisar que el portón quede con candado y la reja sin forzar',
  },
  { position: '2', id: 'cp-2', name: 'Bodega', kind: 'normal', is_closing_point: false },
  { position: '3', id: 'cp-3', name: 'Portería', kind: 'acceso_critico', is_closing_point: true },
];

const escaneo = (checkpointId: string, hora: string, extra: Partial<ScanRow> = {}): ScanRow => ({
  checkpoint_id: checkpointId,
  method: 'nfc',
  scanned_at_server: new Date(hora),
  scanned_at_device: null,
  anomalies: [],
  ...extra,
});

const fotoRow = (id: string, checkpointId: string, extra: Partial<FotoRow> = {}): FotoRow => ({
  id,
  scan_id: `sc-${checkpointId}`,
  checkpoint_id: checkpointId,
  checkpoint_name: 'Portería',
  storage_path: `tenant/patrol/${id}.jpg`,
  mime_type: 'image/jpeg',
  size_bytes: '2048',
  sha256: 'a'.repeat(64),
  taken_at_device: null,
  created_at: new Date('2026-07-31T05:41:00-04:00'),
  ...extra,
});

const tareaRow = (parcial: Partial<TareaRow> = {}): TareaRow => ({
  item_id: 'it-1',
  position: 1,
  label: '¿Se observan anomalías en el lugar?',
  response_type: 'si_no',
  requires_photo: false,
  requires_photo_on_fail: false,
  due_local_time: null,
  checkpoint_id: 'cp-1',
  checkpoint_name: 'Acceso principal',
  response_id: null,
  value: null,
  notes: null,
  failed: null,
  photo_id: null,
  late_minutes: null,
  responded_at: null,
  ...parcial,
});

const incidenteRow = (parcial: Partial<IncidenteRow> = {}): IncidenteRow => ({
  id: 'ev-1',
  criticality: 'alta',
  text: 'Luminaria del pasillo B quemada',
  reported_at_server: new Date('2026-07-31T01:00:00-04:00'),
  ...parcial,
});

const entrada = (parcial: Partial<EntradaModelo> = {}): EntradaModelo => ({
  ronda: RONDA,
  puntos: PUNTOS,
  scans: [],
  fotos: [],
  incidentes: [],
  marca: MARCA,
  umbral: UMBRAL,
  ...parcial,
});

const armar = (parcial: Partial<EntradaModelo> = {}): InformeRonda =>
  construirInformeRonda(entrada(parcial));

/**
 * JPEG minimo que pdfkit acepta embeber: SOI + SOF0 con dimensiones y 3
 * canales. Los datos de imagen son basura a proposito.
 */
function jpegEmbebible(ancho = 16, alto = 12): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt16BE(0xffd8, 0);
  buffer.writeUInt8(0xff, 2);
  buffer.writeUInt8(0xc0, 3);
  buffer.writeUInt16BE(17, 4);
  buffer.writeUInt8(8, 6);
  buffer.writeUInt16BE(alto, 7);
  buffer.writeUInt16BE(ancho, 9);
  buffer.writeUInt8(3, 11);
  return buffer;
}

/** Una llamada a doc.text, con la hoja y la coordenada donde se escribio. */
interface Escrito {
  readonly texto: string;
  readonly pagina: number;
  readonly y: number;
}

interface Corrida {
  readonly pdf: Buffer;
  readonly textos: readonly string[];
  readonly escritos: readonly Escrito[];
  readonly paginas: number;
  readonly yFinal: number;
  readonly xFinal: number;
  readonly limite: number;
}

/**
 * Dibuja sobre un documento propio y devuelve el PDF y TODO el texto escrito.
 *
 * El contenido de un PDF de pdfkit viaja comprimido, asi que no se puede
 * afirmar nada mirando el binario. Interceptar doc.text es la unica forma de
 * comprobar que el informe dice lo que el issue pidio que dijera.
 */
async function generar(dibujo: (doc: PDFKit.PDFDocument) => Promise<void>): Promise<Corrida> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const escritos: Escrito[] = [];
  let hoja = 1;
  doc.on('pageAdded', () => {
    hoja += 1;
  });

  const original = doc.text.bind(doc);
  doc.text = ((texto: unknown, ...resto: unknown[]) => {
    // La `y` de la llamada, o el cursor cuando el llamador no la pasa.
    const y = typeof resto[1] === 'number' ? resto[1] : doc.y;
    escritos.push({ texto: String(texto), pagina: hoja, y });
    return (original as (...args: unknown[]) => PDFKit.PDFDocument)(texto, ...resto);
  }) as typeof doc.text;

  const canal = new PassThrough();
  const partes: Buffer[] = [];
  canal.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<void>((resolve) => canal.on('finish', () => resolve()));
  doc.pipe(canal);

  const pie = instalarPieDePagina(doc, RONDA.timezone, MARCA.mailFooter);
  await dibujo(doc);

  const yFinal = doc.y;
  const xFinal = doc.x;
  const limite = doc.page.height - doc.page.margins.bottom;
  doc.end();
  await terminado;

  return {
    pdf: Buffer.concat(partes),
    textos: escritos.map((e) => e.texto),
    escritos,
    paginas: pie.paginas,
    yFinal,
    xFinal,
    limite,
  };
}

const OPCIONES: OpcionesRender = { raizEvidencia: '/vol/evidencia', maxBytesFoto: 5 * 1024 * 1024 };

const cuerpo = (modelo: InformeRonda, opciones: Partial<OpcionesRender> = {}) =>
  generar((doc) => dibujarCuerpo(doc, modelo, null, { ...OPCIONES, ...opciones }).then(() => undefined));

const esPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';
const unido = (corrida: Corrida) => corrida.textos.join('\n');

describe('dibujarCuerpo · portada', () => {
  it('genera un PDF válido con la identificación de la ronda', async () => {
    const corrida = await cuerpo(
      armar({ scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')) }),
    );

    expect(esPdf(corrida.pdf)).toBe(true);
    expect(corrida.pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
    const texto = unido(corrida);
    expect(texto).toContain('6to Control Nocturno 06 hrs.');
    expect(texto).toContain('Planta Norte · Casa matriz');
    expect(texto).toContain('Vigilancia Austral Ltda');
  });

  it('estampa CONFIDENCIAL, y no lo estampa cuando el tenant lo apaga', async () => {
    const modelo = armar();

    expect(unido(await cuerpo(modelo))).toContain('CONFIDENCIAL');
    expect(unido(await cuerpo(modelo, { etiquetaConfidencial: false }))).not.toContain(
      'CONFIDENCIAL',
    );
  });

  it('muestra la duración redactada igual que el resto de los tiempos', async () => {
    const texto = unido(await cuerpo(armar()));
    // 22:05 -> 05:40 = 455 min = 7 h 35 min.
    expect(texto).toContain('7 h 35 min');
  });

  it('una ronda sin cierre lo dice en vez de inventar una duración', async () => {
    const texto = unido(await cuerpo(armar({ ronda: { ...RONDA, closed_at: null } })));
    expect(texto).toContain('Sin cierre registrado');
  });

  it('las cifras de los indicadores salen de compliance y el veredicto va escrito', async () => {
    const corrida = await cuerpo(armar({ scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')] }));
    const texto = unido(corrida);

    // 1 de 3 = 33%, bajo el umbral por defecto de 70.
    expect(texto).toContain('33%');
    expect(texto).toContain('BAJO EL UMBRAL');
    expect(texto).toContain('CUMPLIMIENTO');
    expect(texto).toContain('OMITIDOS');
  });

  it('una ronda perfecta no recibe el recuadro de motivo', async () => {
    const corrida = await cuerpo(
      armar({ scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')) }),
    );

    expect(unido(corrida)).not.toContain('Motivo de ronda incompleta');
  });

  it('la ronda incompleta explica por qué, con los puntos que faltaron', async () => {
    const corrida = await cuerpo(armar({ scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')] }));
    const texto = unido(corrida);

    expect(texto).toContain('Motivo de ronda incompleta');
    expect(texto).toContain('2 punto(s) sin escanear');
    expect(texto).toContain('El punto de cierre no se escaneó');
  });
});

describe('dibujarCuerpo · bitácora', () => {
  const completa = () =>
    armar({
      scans: [
        escaneo('cp-1', '2026-07-30T23:00:00-04:00'),
        escaneo('cp-2', '2026-07-30T23:30:00-04:00', { anomalies: ['fuera_de_radio_gps'] }),
        escaneo('cp-3', '2026-07-31T00:10:00-04:00'),
      ],
      incidentes: [incidenteRow()],
      tareas: [
        tareaRow({
          response_id: 'rs-1',
          value: 'No',
          failed: false,
          responded_at: new Date('2026-07-30T23:05:00-04:00'),
        }),
      ],
    });

  it('cuenta la ronda hora por hora, con instrucciones, marcas y checklist', async () => {
    const corrida = await cuerpo(completa());
    const texto = unido(corrida);

    expect(texto).toContain('Bitácora de la ronda');
    expect(texto).toContain('TIEMPO');
    expect(texto).toContain('Inicio de ronda');
    expect(texto).toContain('1. Acceso principal');
    expect(texto).toContain('Instrucciones: Revisar que el portón quede con candado');
    expect(texto).toContain('¿Se observan anomalías en el lugar?');
    expect(texto).toContain('Respuesta: No');
    expect(texto).toContain('Marcas: fuera de radio gps');
    expect(texto).toContain('Luminaria del pasillo B quemada');
    expect(texto).toContain('Cierre de ronda');
  });

  it('marca el punto crítico y el de cierre por escrito, no solo con color', async () => {
    const texto = unido(await cuerpo(completa()));
    expect(texto).toContain('3. Portería · CRÍTICO · CIERRE');
  });

  it('la bitácora apagada devuelve el informe a sus tablas de siempre', async () => {
    const texto = unido(await cuerpo(completa(), { bitacora: false }));

    expect(texto).not.toContain('Bitácora de la ronda');
    expect(texto).toContain('Tareas del turno');
    expect(texto).toContain('Novedades e incidentes');
  });

  it('una ronda no iniciada no dibuja la sección ni su cabecera', async () => {
    const corrida = await cuerpo(armar({ ronda: { ...RONDA, started_at: null, closed_at: null } }));

    expect(unido(corrida)).not.toContain('Bitácora de la ronda');
    expect(esPdf(corrida.pdf)).toBe(true);
  });

  it('en una ronda SIN checklist la palabra tarea no aparece ni una vez', async () => {
    // Criterio verificable y no opinable: una seccion vacia en un informe que va
    // al cliente se lee como un dato faltante, no como una funcion que no aplica.
    const corrida = await cuerpo(
      armar({
        scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')),
        incidentes: [incidenteRow()],
      }),
    );

    expect(unido(corrida).toLowerCase()).not.toContain('tarea');
  });

  it('la tarea sin responder aparece al cierre y no en la cronología', async () => {
    const corrida = await cuerpo(
      armar({
        scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
        tareas: [tareaRow({ due_local_time: '23:30:00' })],
      }),
    );
    const texto = unido(corrida);

    expect(texto).toContain('Tareas sin responder (1)');
    expect(texto).toContain('23:30');
  });

  it('el texto largo de una novedad no se recorta a una línea', async () => {
    const largo = 'Portón forzado en el acceso sur. '.repeat(8);
    const corrida = await cuerpo(
      armar({
        scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
        incidentes: [incidenteRow({ text: largo })],
      }),
    );

    // La tabla vieja recortaba a 78 caracteres con recortar(); el libro de
    // novedades termina en juicios laborales y no puede salir mutilado.
    const escrito = corrida.textos.find((t) => t.startsWith('Portón forzado'));
    expect(escrito?.length).toBeGreaterThan(200);
  });

  it('corta en el tope del tenant y deja dicho cuántas anotaciones faltan', async () => {
    const corrida = await cuerpo(completa(), { maxEntradasBitacora: 50 });
    expect(unido(corrida)).not.toContain('por extensión del informe');

    const cortada = await cuerpo(completa(), { maxEntradasBitacora: 3 });
    expect(unido(cortada)).toContain('Se omitieron 4 anotación(es) por extensión del informe');
  });

  it('deja el cursor dentro de la hoja para lo que venga después', async () => {
    const corrida = await cuerpo(completa());

    expect(corrida.xFinal).toBe(40);
    expect(corrida.yFinal).toBeLessThanOrEqual(corrida.limite);
  });
});

describe('dibujarCuerpo · evidencia en línea', () => {
  let raiz: string;

  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'voxia-render-'));
    await mkdir(join(raiz, 'tenant', 'patrol'), { recursive: true });
  });

  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  const conFoto = (extra: Partial<FotoRow> = {}, incluirAnexo = true) =>
    armar({
      scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
      fotos: [
        // taken_at_device es el reloj del telefono: se MUESTRA en el rotulo,
        // aunque el orden de la bitacora nunca dependa de el.
        fotoRow('f1', 'cp-1', { taken_at_device: new Date('2026-07-30T23:01:00-04:00'), ...extra }),
      ],
      incluirAnexo,
    });

  it('incrusta la foto donde ocurrió y la rotula con su huella', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'f1.jpg'), jpegEmbebible());
    let resumen;
    const corrida = await generar(async (doc) => {
      resumen = await dibujarCuerpo(doc, conFoto(), null, { ...OPCIONES, raizEvidencia: raiz });
    });

    expect(resumen).toMatchObject({ fotosIncluidas: 1, fotosOmitidas: 0 });
    expect(unido(corrida)).toContain(`Foto 1 · 23:01 · huella ${'a'.repeat(12)}`);
  });

  it('una foto ilegible deja el hueco marcado y el informe termina igual', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'f1.jpg'), Buffer.from('basura'));
    const avisos: Array<{ id: string; motivo: string }> = [];
    let resumen;
    const corrida = await generar(async (doc) => {
      resumen = await dibujarCuerpo(doc, conFoto(), null, {
        ...OPCIONES,
        raizEvidencia: raiz,
        onEvidenciaFallida: (id, motivo) => avisos.push({ id, motivo }),
      });
    });

    expect(resumen).toMatchObject({ fotosIncluidas: 0, fotosOmitidas: 1 });
    expect(avisos).toEqual([{ id: 'f1', motivo: 'ilegible' }]);
    expect(unido(corrida)).toContain('EVIDENCIA NO DISPONIBLE');
    expect(esPdf(corrida.pdf)).toBe(true);
    expect(corrida.pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
  });

  it('la foto que falta en el volumen no tumba el informe', async () => {
    let resumen;
    const corrida = await generar(async (doc) => {
      resumen = await dibujarCuerpo(doc, conFoto(), null, { ...OPCIONES, raizEvidencia: raiz });
    });

    expect(resumen).toMatchObject({ fotosOmitidas: 1 });
    expect(esPdf(corrida.pdf)).toBe(true);
  });

  it('sin anexo anota la evidencia pero no abre un solo archivo del volumen', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'f1.jpg'), jpegEmbebible());
    let resumen;
    const corrida = await generar(async (doc) => {
      resumen = await dibujarCuerpo(doc, conFoto({}, false), null, {
        ...OPCIONES,
        raizEvidencia: raiz,
      });
    });
    const texto = unido(corrida);

    expect(resumen).toMatchObject({ fotosIncluidas: 0, fotosOmitidas: 0 });
    expect(texto).toContain('imagen no incluida en este envío');
    expect(texto).toContain('Este informe se emite sin imágenes (1 fotografía(s) registradas)');
  });

  it('con las fotos en línea apagadas la evidencia se menciona igual', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'f1.jpg'), jpegEmbebible());
    let resumen;
    const corrida = await generar(async (doc) => {
      resumen = await dibujarCuerpo(doc, conFoto(), null, {
        ...OPCIONES,
        raizEvidencia: raiz,
        fotosEnLinea: false,
      });
    });

    // No se embebe, pero la evidencia queda anotada con su numero y su huella, y
    // el informe dice donde esta la imagen.
    expect(resumen).toMatchObject({ fotosIncluidas: 0 });
    expect(unido(corrida)).toContain('Foto 1 · 23:01');
    expect(unido(corrida)).toContain('ver anexo fotográfico');
  });

  it('la anotación siguiente NO se dibuja encima de la foto', async () => {
    // pdfkit deja el cursor donde termino el ULTIMO texto escrito, y el rotulo de
    // la foto esta a media caja: sin reponer el cursor bajo el bloque completo,
    // la anotacion siguiente pisa la linea de la tarea y el borde de la imagen.
    await writeFile(join(raiz, 'tenant', 'patrol', 'f1.jpg'), jpegEmbebible());
    const modelo = armar({
      scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
      fotos: [
        fotoRow('f1', 'cp-1', { taken_at_device: new Date('2026-07-30T23:01:00-04:00') }),
      ],
      incidentes: [incidenteRow({ reported_at_server: new Date('2026-07-30T23:30:00-04:00') })],
    });

    const corrida = await generar(async (doc) => {
      await dibujarCuerpo(doc, modelo, null, { ...OPCIONES, raizEvidencia: raiz });
    });

    const rotulo = corrida.escritos.find((e) => e.texto.startsWith('Foto 1 ·'));
    const siguiente = corrida.escritos.find((e) => e.texto.startsWith('Luminaria del pasillo'));
    expect(rotulo).toBeDefined();
    expect(siguiente).toBeDefined();
    // Misma hoja, y por debajo de la caja de la foto entera.
    expect(siguiente!.pagina).toBe(rotulo!.pagina);
    expect(siguiente!.y).toBeGreaterThan(rotulo!.y + 20);
  });

  it('la evidencia de un punto fuera de la ruta no se pierde', async () => {
    const modelo = armar({
      scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
      fotos: [fotoRow('f9', 'cp-fuera', { checkpoint_name: 'Patio trasero' })],
    });

    const corrida = await generar(async (doc) => {
      await dibujarCuerpo(doc, modelo, null, { ...OPCIONES, raizEvidencia: raiz });
    });

    expect(unido(corrida)).toContain('Evidencia sin punto en la ruta (1)');
    expect(unido(corrida)).toContain('Patio trasero');
  });
});

describe('instalarPieDePagina', () => {
  const PIE = 'Documento generado automáticamente el';

  it('deja el pie en TODAS las hojas, no solo en la última', async () => {
    // El defecto que ataja: dibujarPie se llamaba UNA vez al final del cuerpo, y
    // con una bitacora de varias paginas la fecha de generacion y la linea legal
    // del tenant aparecian solo en la ultima hoja.
    const corrida = await generar(async (doc) => {
      doc.addPage();
      doc.addPage();
    });

    expect(corrida.paginas).toBe(3);
    expect(corrida.textos.filter((t) => t.startsWith(PIE))).toHaveLength(3);
    expect(corrida.textos.filter((t) => t === MARCA.mailFooter)).toHaveLength(3);
  });

  it('numera las páginas sin prometer un total que no puede conocer', async () => {
    const corrida = await generar(async (doc) => {
      doc.addPage();
    });

    expect(corrida.textos).toContain('Página 1');
    expect(corrida.textos).toContain('Página 2');
    // "Página 1 de 2" exigiria bufferPages, que es el pico de memoria que el
    // diseño del renderer existe para evitar.
    expect(unido(corrida)).not.toMatch(/Página \d+ de/);
  });

  it('el pie no se lleva el cursor al fondo de la hoja nueva', async () => {
    const corrida = await generar(async (doc) => {
      doc.addPage();
    });

    expect(corrida.yFinal).toBe(40);
    expect(corrida.xFinal).toBe(40);
  });

  it('un informe largo reparte el pie por todas sus hojas', async () => {
    const muchos: PuntoEsperadoRow[] = Array.from({ length: 60 }, (_, i) => ({
      position: String(i + 1),
      id: `cp-${i}`,
      name: `Punto de control ${i + 1}`,
      kind: 'normal',
      is_closing_point: false,
    }));
    const modelo = armar({
      puntos: muchos,
      scans: muchos.map((p, i) =>
        escaneo(p.id, new Date(Date.UTC(2026, 6, 31, 2, i)).toISOString()),
      ),
    });

    const corrida = await cuerpo(modelo);

    expect(corrida.paginas).toBeGreaterThan(2);
    expect(corrida.textos.filter((t) => t.startsWith(PIE))).toHaveLength(corrida.paginas);
  });
});
