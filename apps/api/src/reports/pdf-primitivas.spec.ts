import {
  celdaAnexo,
  formatearFechaHora,
  formatearHora,
  pasoDeEtiquetas,
  posicionEnLinea,
  recortar,
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
