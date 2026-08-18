import PDFDocument from 'pdfkit';

import {
  ANCHO_INDICADOR,
  celdaAnexo,
  dibujarIndicadores,
  dibujarLineaDeTiempo,
  escalaLineaDeTiempo,
  formatearFechaHora,
  formatearHora,
  pasoDeEtiquetas,
  posicionEnLinea,
  recortar,
  type DatosLineaTiempo,
  type HitoLinea,
} from './pdf-primitivas';

/**
 * Aritmetica del anexo y formato de fechas. No se importa pdfkit: estas son
 * las partes que se pueden equivocar en silencio —una celda de alto negativo
 * que la libreria dibuja sin quejarse— y por eso viven afuera del dibujo.
 */

// Hoja A4 con margen 40, franja de titulo consumida y pie reservado.
const GEOMETRIA = {
  x0: 40,
  ancho: 515,
  yInicio: 80,
  yLimite: 776,
  columnas: 2,
  filas: 2,
  separacion: 14,
};

describe('celdaAnexo', () => {
  it('reparte las 4 celdas de la hoja sin superponerlas', () => {
    const celdas = [0, 1, 2, 3].map((p) => celdaAnexo(GEOMETRIA, p));

    // Fila de arriba a la misma altura, columnas distintas.
    expect(celdas[0]!.y).toBe(celdas[1]!.y);
    expect(celdas[1]!.x).toBeGreaterThan(celdas[0]!.x + celdas[0]!.ancho - 1);
    // Fila de abajo mas abajo, misma reparticion horizontal.
    expect(celdas[2]!.y).toBeGreaterThan(celdas[0]!.y + celdas[0]!.alto - 1);
    expect(celdas[2]!.x).toBe(celdas[0]!.x);
    expect(celdas[3]!.x).toBe(celdas[1]!.x);
  });

  it('todas las celdas tienen alto y ancho positivos y caben en la hoja', () => {
    // La regresion que esto ataja: leer el cursor despues de escribir el pie
    // deja yInicio al fondo de la pagina y produce celdas de alto negativo.
    for (const posicion of [0, 1, 2, 3]) {
      const celda = celdaAnexo(GEOMETRIA, posicion);
      expect(celda.alto).toBeGreaterThan(0);
      expect(celda.ancho).toBeGreaterThan(0);
      expect(celda.y).toBeGreaterThanOrEqual(GEOMETRIA.yInicio);
      expect(celda.y + celda.alto).toBeLessThanOrEqual(GEOMETRIA.yLimite + 0.001);
      expect(celda.x + celda.ancho).toBeLessThanOrEqual(GEOMETRIA.x0 + GEOMETRIA.ancho + 0.001);
    }
  });

  it('la separación queda entre celdas y no en los bordes', () => {
    const primera = celdaAnexo(GEOMETRIA, 0);
    const segunda = celdaAnexo(GEOMETRIA, 1);

    expect(primera.x).toBe(GEOMETRIA.x0);
    expect(segunda.x - (primera.x + primera.ancho)).toBeCloseTo(GEOMETRIA.separacion, 5);
  });
});

describe('formato de horas', () => {
  const tz = 'America/Santiago';

  it('usa la zona horaria del recinto, no la del servidor', () => {
    // 2026-07-31T05:40 en -04:00 son las 05:40 en Santiago (invierno, UTC-4).
    const valor = new Date('2026-07-31T05:40:00-04:00');
    expect(formatearFechaHora(valor, tz)).toBe('31-07-2026, 05:40');
    expect(formatearHora(valor, tz)).toBe('05:40');
  });

  it('un null se muestra como guion y no como "Invalid Date"', () => {
    expect(formatearFechaHora(null, tz)).toBe('—');
    expect(formatearHora(null, tz)).toBe('—');
  });

  it('una zona horaria inválida degrada a ISO en vez de reventar', () => {
    const valor = new Date('2026-07-31T05:40:00Z');
    expect(formatearFechaHora(valor, 'No/Existe')).toBe(valor.toISOString());
  });

  it('una fecha inválida no rompe el informe', () => {
    expect(formatearFechaHora('no soy una fecha', tz)).toBe('—');
  });
});

describe('recortar', () => {
  it('deja pasar lo que cabe y corta con elipsis lo que no', () => {
    expect(recortar('Portería', 20)).toBe('Portería');
    expect(recortar('Acceso principal del estacionamiento subterráneo', 12)).toBe('Acceso prin…');
  });
});

/**
 * Aritmetica de la linea de tiempo (#308). Misma razon que celdaAnexo: pdfkit
 * dibuja sin quejarse una marca en NaN o fuera de la caja, y eso solo se ve
 * abriendo el PDF.
 */
describe('posicionEnLinea', () => {
  const ANCHO = 515;
  const t0 = Date.UTC(2026, 6, 31, 2, 0, 0);
  const t1 = Date.UTC(2026, 6, 31, 3, 0, 0);

  it('reparte proporcionalmente entre los dos extremos', () => {
    expect(posicionEnLinea(t0, t1, ANCHO, t0)).toBe(0);
    expect(posicionEnLinea(t0, t1, ANCHO, t1)).toBe(ANCHO);
    expect(posicionEnLinea(t0, t1, ANCHO, (t0 + t1) / 2)).toBeCloseTo(ANCHO / 2, 5);
  });

  it('una ventana de duración cero no divide por cero', () => {
    // Sin este corte la marca saldria en NaN y pdfkit lo escribe en el archivo
    // sin protestar: el visor abre un PDF con la linea de tiempo en blanco.
    expect(posicionEnLinea(t0, t0, ANCHO, t0)).toBe(0);
    expect(Number.isNaN(posicionEnLinea(t0, t0, ANCHO, t1))).toBe(false);
  });

  it('recorta lo que cae fuera del rango en vez de salirse de la caja', () => {
    expect(posicionEnLinea(t0, t1, ANCHO, t0 - 3_600_000)).toBe(0);
    expect(posicionEnLinea(t0, t1, ANCHO, t1 + 3_600_000)).toBe(ANCHO);
  });
});

/**
 * Lo que solo se puede comprobar contra las METRICAS REALES de la fuente y las
 * coordenadas que se le pasan a pdfkit: que lo escrito quepa donde se dijo.
 *
 * pdfkit dibuja sin quejarse un texto que sobresale de su recuadro o una
 * etiqueta encima de una marca, y eso no aparece en ningun assert de contenido:
 * solo se ve abriendo el PDF. Por eso estas dos pruebas espian las llamadas de
 * dibujo en vez de mirar el binario.
 */
interface Escrito {
  readonly texto: string;
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}
interface Caja {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

function espiar(dibujo: (doc: PDFKit.PDFDocument) => void): {
  escritos: Escrito[];
  cajas: Caja[];
} {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const escritos: Escrito[] = [];
  const cajas: Caja[] = [];

  const textoOriginal = doc.text.bind(doc);
  doc.text = ((texto: unknown, ...resto: unknown[]) => {
    const x = typeof resto[0] === 'number' ? resto[0] : doc.x;
    const y = typeof resto[1] === 'number' ? resto[1] : doc.y;
    const opciones = (resto.find((r) => typeof r === 'object' && r !== null) ?? {}) as {
      width?: number;
    };
    // La fuente y el cuerpo ya estan fijados por la llamada encadenada, asi que
    // se mide exactamente lo que se va a escribir.
    escritos.push({
      texto: String(texto),
      x,
      y,
      ancho: doc.widthOfString(String(texto)),
      alto:
        opciones.width === undefined
          ? doc.currentLineHeight()
          : doc.heightOfString(String(texto), { width: opciones.width }),
    });
    return (textoOriginal as (...args: unknown[]) => PDFKit.PDFDocument)(texto, ...resto);
  }) as typeof doc.text;

  const rectOriginal = doc.rect.bind(doc);
  doc.rect = ((x: number, y: number, ancho: number, alto: number) => {
    cajas.push({ x, y, ancho, alto });
    return rectOriginal(x, y, ancho, alto);
  }) as typeof doc.rect;

  dibujo(doc);
  doc.end();
  return { escritos, cajas };
}

const seCruzan = (a: Caja, b: Caja): boolean =>
  a.x < b.x + b.ancho && b.x < a.x + a.ancho && a.y < b.y + b.alto && b.y < a.y + a.alto;

describe('dibujarIndicadores', () => {
  it('ningún texto de la ficha se escribe fuera de su recuadro', () => {
    // El defecto que ataja: "Sobre el umbral · umbral 70%" mide 85,8pt en cuerpo
    // 6,5 contra los 84pt utiles de la ficha —y "BAJO EL UMBRAL · umbral 70%",
    // 95,7pt—, asi que pdfkit lo envolvia y la segunda linea cruzaba el borde
    // inferior. Pasaba con 0%, con 89% y con 100%: no dependia de los datos.
    for (const detalle of [
      'Sobre el umbral · umbral 70%',
      'BAJO EL UMBRAL · umbral 70%',
      'Sobre el umbral · umbral 100%',
      'BAJO EL UMBRAL · umbral 85%',
    ]) {
      const { escritos, cajas } = espiar((doc) =>
        dibujarIndicadores(doc, [
          { rotulo: 'Cumplimiento', cifra: '100%', detalle },
          { rotulo: 'Escaneados', cifra: '40' },
        ]),
      );

      expect(cajas).toHaveLength(2);
      expect(escritos.length).toBeGreaterThanOrEqual(4);
      for (const escrito of escritos) {
        const caja = cajas.find((c) => escrito.x >= c.x - 0.01 && escrito.x < c.x + c.ancho);
        expect(caja).toBeDefined();
        expect(caja!.ancho).toBe(ANCHO_INDICADOR);
        expect(escrito.x + escrito.ancho).toBeLessThanOrEqual(caja!.x + caja!.ancho + 0.5);
        expect(escrito.y + escrito.alto).toBeLessThanOrEqual(caja!.y + caja!.alto + 0.5);
      }
    }
  });
});

describe('escalaLineaDeTiempo', () => {
  const tz = 'America/Santiago';
  const VENTANA = {
    desde: new Date('2026-07-30T22:00:00-04:00'),
    hasta: new Date('2026-07-31T06:00:00-04:00'),
  };
  const inicio = new Date('2026-07-30T22:05:00-04:00');
  const cierre = new Date('2026-07-30T22:18:00-04:00');

  const datos = (parcial: Partial<DatosLineaTiempo> = {}): DatosLineaTiempo => ({
    ventana: VENTANA,
    ejecucion: { inicio, cierre },
    hitos: [],
    colorMarca: '#1f3b73',
    timezone: tz,
    ...parcial,
  });

  it('la escala es lo que ocurrió, no la ventana programada', () => {
    // El defecto que ataja: con la escala armada sobre la ventana, una ronda de
    // 13 minutos dentro de un turno de 8 horas repartia sus hitos sobre 7pt de
    // los 515 del ancho util, encimados entre si.
    const escala = escalaLineaDeTiempo(datos());

    expect((escala.t1 - escala.t0) / 60_000).toBe(13);
    expect(escala.ventanaRecortada).toBe(true);
  });

  it('una ronda que no ocurrió cae en la ventana, que es lo único que se sabe', () => {
    const escala = escalaLineaDeTiempo(datos({ ejecucion: { inicio: null, cierre: null } }));

    expect((escala.t1 - escala.t0) / 60_000).toBe(480);
    expect(escala.ventanaRecortada).toBe(false);
  });

  it('los hitos entran a la escala aunque caigan fuera de inicio y cierre', () => {
    // Un escaneo tardio que llega por la cola offline despues del cierre no
    // puede quedar apilado contra el borde derecho.
    const tarde = new Date('2026-07-30T22:40:00-04:00');
    const escala = escalaLineaDeTiempo(
      datos({ hitos: [{ instante: tarde, forma: 'escaneo' }] }),
    );

    expect(escala.t1).toBe(tarde.getTime());
  });

  it('una ronda sin cierre llega hasta su último hito', () => {
    const ultimo = new Date('2026-07-30T23:30:00-04:00');
    const escala = escalaLineaDeTiempo(
      datos({
        ejecucion: { inicio, cierre: null },
        hitos: [{ instante: ultimo, forma: 'escaneo' }],
      }),
    );

    expect(escala.t0).toBe(inicio.getTime());
    expect(escala.t1).toBe(ultimo.getTime());
  });
});

describe('dibujarLineaDeTiempo', () => {
  const tz = 'America/Santiago';

  it('rotula los extremos con el tramo ejecutado y avisa que recortó la ventana', () => {
    const { escritos } = espiar((doc) =>
      dibujarLineaDeTiempo(doc, {
        ventana: {
          desde: new Date('2026-07-30T22:00:00-04:00'),
          hasta: new Date('2026-07-31T06:00:00-04:00'),
        },
        ejecucion: {
          inicio: new Date('2026-07-30T22:05:00-04:00'),
          cierre: new Date('2026-07-30T22:18:00-04:00'),
        },
        hitos: Array.from({ length: 12 }, (_, i) => ({
          instante: new Date(Date.parse('2026-07-30T22:05:00-04:00') + i * 60_000),
          forma: 'escaneo' as const,
        })),
        colorMarca: '#1f3b73',
        timezone: tz,
      }),
    );
    const textos = escritos.map((e) => e.texto);

    expect(textos).toContain('22:05');
    expect(textos).toContain('22:18');
    // La ventana ya esta escrita con todas sus letras en la ficha de la portada;
    // aca solo se avisa que la escala no la cubre entera.
    expect(textos.join(' ')).toContain('la ventana programada era 22:00—06:00');
  });

  it('ninguna etiqueta de hora se dibuja encima de una marca de hito', () => {
    // El defecto que ataja: las etiquetas intermedias se escribian a yTope+9 con
    // 7,5pt de alto y las marcas de tarea a yBase-14 = yTope+12. Los dos rangos
    // se cruzan siempre; se ve cada vez que una tarea cae cerca de una etiqueta.
    const arranque = Date.parse('2026-07-30T22:00:00-04:00');
    const hitos: HitoLinea[] = [];
    for (let minuto = 0; minuto <= 240; minuto += 30) {
      hitos.push({ instante: new Date(arranque + minuto * 60_000), forma: 'tarea' });
      hitos.push({ instante: new Date(arranque + minuto * 60_000), forma: 'escaneo' });
    }

    const { escritos, cajas } = espiar((doc) =>
      dibujarLineaDeTiempo(doc, {
        ventana: { desde: new Date(arranque), hasta: new Date(arranque + 240 * 60_000) },
        ejecucion: {
          inicio: new Date(arranque),
          cierre: new Date(arranque + 240 * 60_000),
        },
        hitos,
        colorMarca: '#1f3b73',
        timezone: tz,
      }),
    );

    // Las marcas de tarea son los cuadraditos de 4x4 sobre el eje.
    const marcas = cajas.filter((c) => c.ancho === 4 && c.alto === 4);
    expect(marcas.length).toBeGreaterThan(4);
    // Y hay etiquetas intermedias de verdad, no solo las de los extremos.
    expect(escritos.length).toBeGreaterThan(2);

    for (const escrito of escritos) {
      for (const marca of marcas) {
        expect(seCruzan(escrito, marca)).toBe(false);
      }
    }
  });
});

describe('pasoDeEtiquetas', () => {
  const ANCHO = 515;

  it('usa el paso de 5 minutos en una ronda corta', () => {
    // La ronda del informe de referencia dura 13 minutos.
    expect(pasoDeEtiquetas(13, ANCHO)).toBe(5);
  });

  it('sube a 2 horas en un turno de 8 horas para no amontonar etiquetas', () => {
    expect(pasoDeEtiquetas(480, ANCHO)).toBe(120);
  });

  it('una duración imposible no propone ninguna etiqueta intermedia', () => {
    expect(pasoDeEtiquetas(0, ANCHO)).toBeNull();
    expect(pasoDeEtiquetas(Number.NaN, ANCHO)).toBeNull();
    expect(pasoDeEtiquetas(60, 0)).toBeNull();
  });

  it('nunca deja más de 6 etiquetas intermedias', () => {
    for (const duracion of [4, 13, 45, 90, 240, 480, 1440, 5000]) {
      const paso = pasoDeEtiquetas(duracion, ANCHO);
      if (paso === null) continue;
      expect(Math.floor(duracion / paso)).toBeLessThanOrEqual(6);
      // Y siempre queda espacio para que la etiqueta se lea.
      expect((paso / duracion) * ANCHO).toBeGreaterThanOrEqual(34);
    }
  });
});
