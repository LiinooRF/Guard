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
  altoDelPlano,
  armarNotas,
  dibujarMapaRecorrido,
  formatearDistancia,
  huecosDeTraza,
  PADDING_CAJA,
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
    let hojasNuevas = 0;
    let yFinal = 0;
    let fondoDeHoja = 0;

    await generar((doc) => {
      // Se deja el cursor casi al fondo de la hoja, como quedaria despues de una
      // tabla larga de puntos. El espacio se reserva ANTES del titulo, asi que
      // la seccion completa tiene que saltar de hoja: si el titulo se escribiera
      // primero, quedaria huerfano al final de la anterior.
      //
      // Se cuenta la hoja agregada y NO se compara el cursor final contra el
      // forzado: desde que el plano usa la hoja que le sobra, la seccion ocupa
      // casi una pagina entera y termina abajo aunque haya saltado bien.
      doc.on('pageAdded', () => {
        hojasNuevas += 1;
      });
      doc.y = doc.page.height - doc.page.margins.bottom - 60;
      dibujarMapaRecorrido(doc, mapa);
      yFinal = doc.y;
      fondoDeHoja = doc.page.height - doc.page.margins.bottom;
    });

    expect(hojasNuevas).toBe(1);
    expect(yFinal).toBeLessThanOrEqual(fondoDeHoja);
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

/**
 * El recuadro del plano tiene que quedar con la MISMA proporcion que el
 * encuadre, para que la cartografia llene el interior en vez de encogerse y
 * dejar bandas blancas a los lados. El 02-09-2026 un recorrido de 951 x 542 m
 * salia con 78 pt de banda a cada costado porque `altoDelPlano` calculaba el
 * alto que pedia el INTERIOR pero se asignaba como alto TOTAL del recuadro.
 */
describe('altoDelPlano', () => {
  const ANCHO_INTERIOR = 471;
  const encuadre = (anchoM: number, altoM: number) => ({
    esteMin: 0,
    esteMax: anchoM,
    norteMin: 0,
    norteMax: altoM,
  });

  it.each([
    ['el recorrido del 02-09', 951, 542],
    ['apaisado suave', 600, 400],
    ['al limite de la hoja', 500, 380],
  ])('deja el interior con la proporcion del encuadre (%s)', (_caso, anchoM, altoM) => {
    const alto = altoDelPlano(encuadre(anchoM, altoM), ANCHO_INTERIOR);
    const altoInterior = alto - PADDING_CAJA * 2;

    const escala = Math.min(ANCHO_INTERIOR / anchoM, altoInterior / altoM);
    const bandaLateral = ANCHO_INTERIOR - anchoM * escala;
    const bandaVertical = altoInterior - altoM * escala;

    expect(bandaLateral).toBeLessThanOrEqual(1);
    expect(bandaVertical).toBeLessThanOrEqual(1);
  });

  it('respeta el alto minimo y el maximo de la hoja', () => {
    expect(altoDelPlano(encuadre(2_000, 50), ANCHO_INTERIOR)).toBe(250);
    expect(altoDelPlano(encuadre(50, 2_000), ANCHO_INTERIOR)).toBe(430);
  });

  /**
   * Un recorrido cuadrado o vertical pediria un recuadro mas alto que lo que
   * queda de hoja, asi que se recorta a ALTO_MAPA_MAX y ahi si sobra ancho.
   * Es el limite del papel, no el defecto que se corrigio: el mapa sigue
   * centrado y a escala, solo que no llena los costados.
   */
  it('en recorridos cuadrados el techo de la hoja manda y sobra ancho', () => {
    const alto = altoDelPlano(encuadre(400, 380), ANCHO_INTERIOR);

    expect(alto).toBe(430);
  });
});


/**
 * El 05-09-2026, en una prueba de terreno, el telefono dejo de reportar doce
 * minutos: el guardia entro a un supermercado con el equipo guardado. El
 * informe imprimio "1,7 km · 126 posiciones" y dibujo una linea recta sobre
 * ese silencio, sin decir una palabra. Quien lo recibe lee un recorrido
 * acreditado de punta a punta, y ese tramo nadie lo midio.
 */
describe('tramos sin registrar', () => {
  const trazaCada = (segundos: readonly number[]) => {
    let t = new Date('2026-09-05T16:00:00Z').getTime();
    const filas: TrazaRow[] = [
      {
        recorded_at_device: new Date(t),
        latitude: RECINTO.lat.toFixed(6),
        longitude: RECINTO.lng.toFixed(6),
        accuracy_m: '10.00',
      },
    ];
    segundos.forEach((seg, i) => {
      t += seg * 1_000;
      filas.push({
        recorded_at_device: new Date(t),
        latitude: (RECINTO.lat + 0.0004 * (i + 1)).toFixed(6),
        longitude: (RECINTO.lng + 0.0004 * (i + 1)).toFixed(6),
        accuracy_m: '10.00',
      });
    });
    return construirMapaRecorrido(entrada({ puntos: [punto(1)], traza: filas }));
  };

  it('un muestreo normal no tiene ningun tramo sin registrar', () => {
    expect(huecosDeTraza(trazaCada([15, 15, 15, 20, 15]))).toHaveLength(0);
  });

  it('doce minutos de silencio cuentan como un tramo sin medir', () => {
    const huecos = huecosDeTraza(trazaCada([15, 726, 15]));

    expect(huecos).toHaveLength(1);
    expect(huecos[0]!.segundos).toBe(726);
    expect(huecos[0]!.desde).toBe(1);
  });

  it('el informe lo dice y aclara que la distancia va en linea recta', () => {
    const notas = armarNotas(trazaCada([15, 726, 15]));

    const aviso = notas.find((n) => n.includes('se interrumpió'));
    expect(aviso).toBeDefined();
    expect(aviso).toContain('una vez');
    expect(aviso).toContain('12 min');
    expect(aviso).toContain('línea recta');
  });

  it('sin interrupciones no ensucia el informe con el aviso', () => {
    expect(armarNotas(trazaCada([15, 15, 15])).some((n) => n.includes('se interrumpió'))).toBe(
      false,
    );
  });
});
