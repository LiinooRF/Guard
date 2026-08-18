import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';

import {
  construirMapaRecorrido,
  type CoordenadaPuntoRow,
  type EntradaMapa,
  type MapaRecorrido,
  type TrazaRow,
} from './mapa-recorrido.model';
import {
  armarNotas,
  dibujarMapaRecorrido,
  formatearDistancia,
} from './mapa-recorrido.renderer';
import type { FilaPunto } from './patrol-report.model';

/**
 * El dibujo se prueba de dos maneras y ninguna mira pixeles: que pdfkit acepte
 * lo que le mandamos (un PDF que abre y termina bien) y que el cursor quede
 * donde corresponde para que la seccion siguiente no se escriba encima.
 *
 * Lo que este archivo NO puede probar es como se ve impreso. Eso se revisa
 * abriendo un informe de verdad; aca solo se ataja que no reviente.
 */

const RECINTO = { lat: -33.45, lng: -70.66 };

const punto = (numero: number, omitido = false): FilaPunto => ({
  numero,
  checkpointId: `cp-${numero}`,
  nombre: `Punto de control ${numero}`,
  esCierre: false,
  esCritico: numero === 3,
  omitido,
  escaneadoEn: omitido ? null : new Date('2026-07-30T23:00:00-04:00'),
  metodo: omitido ? null : 'nfc',
  anomalias: [],
  instrucciones: null,
});

const coordenada = (id: string, lat: number, lng: number): CoordenadaPuntoRow => ({
  id,
  latitude: lat.toFixed(6),
  longitude: lng.toFixed(6),
});

const traza = (indice: number): TrazaRow => ({
  recorded_at_device: new Date(Date.UTC(2026, 6, 31, 2, 0, indice)),
  latitude: (RECINTO.lat + Math.sin(indice / 9) * 0.0006).toFixed(6),
  longitude: (RECINTO.lng + indice * 0.00002).toFixed(6),
  accuracy_m: '9.00',
});

const entrada = (parcial: Partial<EntradaMapa> = {}): EntradaMapa => ({
  puntos: [],
  coordenadas: [],
  traza: [],
  escaneos: [],
  recinto: null,
  maxErrorTrazaM: 100,
  maxPuntosTraza: 1500,
  trazaActivada: true,
  ...parcial,
});

function mapaCompleto(cantidadTraza = 40): MapaRecorrido {
  return construirMapaRecorrido(
    entrada({
      puntos: [punto(1), punto(2, true), punto(3), punto(4)],
      coordenadas: [
        coordenada('cp-1', RECINTO.lat, RECINTO.lng),
        coordenada('cp-2', RECINTO.lat + 0.0008, RECINTO.lng + 0.0004),
        coordenada('cp-3', RECINTO.lat + 0.0003, RECINTO.lng + 0.0012),
        coordenada('cp-4', RECINTO.lat - 0.0005, RECINTO.lng + 0.0009),
      ],
      traza: Array.from({ length: cantidadTraza }, (_, i) => traza(i)),
      escaneos: [
        {
          checkpoint_id: 'cp-3',
          scanned_at_server: new Date('2026-07-30T23:40:00-04:00'),
          latitude: (RECINTO.lat + 0.0009).toFixed(6),
          longitude: (RECINTO.lng + 0.0014).toFixed(6),
          accuracy_m: '35.00',
          anomalies: ['fuera_de_radio_gps'],
        },
      ],
    }),
  );
}

/** Genera un PDF de una hoja con lo que dibuje el bloque. */
async function generar(dibujo: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const canal = new PassThrough();
  const partes: Buffer[] = [];
  canal.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<void>((resolve) => canal.on('finish', () => resolve()));
  doc.pipe(canal);
  dibujo(doc);
  doc.end();
  await terminado;
  return Buffer.concat(partes);
}

const esPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';

describe('dibujarMapaRecorrido', () => {
  it('dibuja el plano completo y cierra un PDF válido', async () => {
    const mapa = mapaCompleto();

    const pdf = await generar((doc) => dibujarMapaRecorrido(doc, mapa));

    expect(esPdf(pdf)).toBe(true);
    expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
  });

  it('una ronda sin ninguna coordenada no rompe el informe', async () => {
    const mapa = construirMapaRecorrido(entrada({ puntos: [punto(1)], trazaActivada: false }));

    const pdf = await generar((doc) => dibujarMapaRecorrido(doc, mapa));

    expect(mapa.hayDatos).toBe(false);
    expect(esPdf(pdf)).toBe(true);
  });

  it('un recorrido de miles de posiciones se dibuja simplificado y sale igual', async () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
        traza: Array.from({ length: 4000 }, (_, i) => traza(i)),
        maxPuntosTraza: 800,
      }),
    );

    const pdf = await generar((doc) => dibujarMapaRecorrido(doc, mapa));

    expect(mapa.trazaSubmuestreada).toBe(true);
    expect(mapa.traza.length).toBeLessThanOrEqual(801);
    expect(esPdf(pdf)).toBe(true);
  });

  it('una traza de un solo punto no intenta dibujar una línea', async () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
        traza: [traza(0)],
      }),
    );

    const pdf = await generar((doc) => dibujarMapaRecorrido(doc, mapa));

    expect(esPdf(pdf)).toBe(true);
  });

  it('deja el cursor bajo la caja y dentro de la hoja', async () => {
    // Si el cursor quedara donde lo dejo el ultimo doc.text del dibujo —el
    // numero adentro de un circulo—, la seccion siguiente se escribiria encima
    // del mapa.
    const mapa = mapaCompleto();
    let yFinal = 0;
    let xFinal = 0;
    let limite = 0;

    await generar((doc) => {
      dibujarMapaRecorrido(doc, mapa);
      yFinal = doc.y;
      xFinal = doc.x;
      limite = doc.page.height - doc.page.margins.bottom;
    });

    expect(xFinal).toBe(40);
    expect(yFinal).toBeGreaterThan(300);
    expect(yFinal).toBeLessThanOrEqual(limite);
  });

  it('el mapa que no cabe se va a la hoja siguiente en vez de partirse', async () => {
    const mapa = mapaCompleto();
    let yForzado = 0;
    let yFinal = 0;

    await generar((doc) => {
      // Se deja el cursor casi al fondo de la hoja, como quedaria despues de una
      // tabla larga de puntos. El espacio se reserva ANTES del titulo, asi que
      // la seccion completa tiene que saltar de hoja: si el titulo se escribiera
      // primero, quedaria huerfano al final de la anterior.
      yForzado = doc.page.height - doc.page.margins.bottom - 60;
      doc.y = yForzado;
      dibujarMapaRecorrido(doc, mapa);
      yFinal = doc.y;
    });

    expect(yFinal).toBeLessThan(yForzado);
  });
});

describe('armarNotas', () => {
  it('avisa de los puntos que no se pueden dibujar y de cuántos son', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2), punto(3)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
      }),
    );

    const notas = armarNotas(mapa).join(' | ');

    expect(notas).toContain('2 punto(s) sin coordenada cargada');
    expect(notas).toContain('Punto de control 2');
  });

  it('siempre deja dicho que el plano no lleva cartografía de fondo', () => {
    expect(armarNotas(mapaCompleto()).join(' | ')).toContain('sin cartografía de fondo');
  });

  it('avisa cuando la empresa no registra recorrido', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
        trazaActivada: false,
      }),
    );

    expect(armarNotas(mapa).join(' | ')).toContain('no tiene activado el registro de recorrido');
  });
});

describe('formatearDistancia', () => {
  it('usa metros bajo el kilómetro y kilómetros con coma sobre él', () => {
    expect(formatearDistancia(0)).toBe('0 m');
    expect(formatearDistancia(940.4)).toBe('940 m');
    expect(formatearDistancia(1500)).toBe('1,5 km');
  });

  it('un valor imposible no imprime NaN en el informe', () => {
    expect(formatearDistancia(Number.NaN)).toBe('—');
  });
});
