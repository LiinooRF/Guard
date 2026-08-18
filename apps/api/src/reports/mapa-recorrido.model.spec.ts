import {
  SPAN_MINIMO_M,
  ajustarACaja,
  barraEscala,
  construirMapaRecorrido,
  encuadreDe,
  enPdf,
  proyectar,
  type CoordenadaPuntoRow,
  type EntradaMapa,
  type EscaneoGpsRow,
  type TrazaRow,
} from './mapa-recorrido.model';
import type { FilaPunto } from './patrol-report.model';

/**
 * Estos tests NO importan pdfkit: prueban la aritmetica del mapa —proyeccion,
 * encuadre, escala, que se dibuja y que se descarta— que es justo la parte que
 * se equivoca en silencio. Un PDF generado no dice si la escala esta mal.
 */

const RECINTO = { lat: -33.45, lng: -70.66 };

/** 0.001 grados de latitud son ~111,19 m en cualquier meridiano. */
const GRADO_MILESIMO_M = 111.19;

const punto = (numero: number, parcial: Partial<FilaPunto> = {}): FilaPunto => ({
  numero,
  checkpointId: `cp-${numero}`,
  nombre: `Punto ${numero}`,
  esCierre: false,
  esCritico: false,
  omitido: false,
  escaneadoEn: new Date('2026-07-30T23:00:00-04:00'),
  metodo: 'nfc',
  anomalias: [],
  instrucciones: null,
  ...parcial,
});

const coordenada = (
  id: string,
  lat: number | null,
  lng: number | null,
): CoordenadaPuntoRow => ({
  id,
  latitude: lat === null ? null : lat.toFixed(6),
  longitude: lng === null ? null : lng.toFixed(6),
});

const traza = (lat: number, lng: number, minuto: number, error?: number): TrazaRow => ({
  recorded_at_device: new Date(Date.UTC(2026, 6, 31, 2, minuto, 0)),
  latitude: lat.toFixed(6),
  longitude: lng.toFixed(6),
  accuracy_m: error === undefined ? null : error.toFixed(2),
});

const escaneo = (
  checkpointId: string,
  parcial: Partial<EscaneoGpsRow> = {},
): EscaneoGpsRow => ({
  checkpoint_id: checkpointId,
  scanned_at_server: new Date('2026-07-30T23:10:00-04:00'),
  latitude: null,
  longitude: null,
  accuracy_m: null,
  anomalies: [],
  ...parcial,
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

describe('proyectar', () => {
  it('convierte grados a metros locales con el norte hacia arriba', () => {
    const arriba = proyectar(RECINTO.lat + 0.001, RECINTO.lng, RECINTO);

    expect(arriba.norte).toBeCloseTo(GRADO_MILESIMO_M, 1);
    expect(arriba.este).toBeCloseTo(0, 6);
  });

  it('achica el eje este-oeste con el coseno de la latitud', () => {
    // A 33 grados de latitud, un grado de longitud mide ~0,834 de uno de
    // latitud. Sin el coseno el plano saldria estirado a lo ancho y la barra de
    // escala mentiria en un eje.
    const derecha = proyectar(RECINTO.lat, RECINTO.lng + 0.001, RECINTO);

    expect(derecha.este).toBeCloseTo(GRADO_MILESIMO_M * Math.cos((RECINTO.lat * Math.PI) / 180), 1);
    expect(derecha.norte).toBeCloseTo(0, 6);
  });

  it('no da media vuelta al mundo cruzando el antimeridiano', () => {
    const cerca = proyectar(0, -179.999, { lat: 0, lng: 179.999 });

    expect(Math.abs(cerca.este)).toBeLessThan(500);
  });
});

describe('encuadreDe', () => {
  it('nunca deja un lado en cero, aunque todo caiga en el mismo lugar', () => {
    // El bug que ataja: un lado de cero metros manda la escala a infinito y el
    // error normal del GPS pasa a ocupar media hoja.
    const encuadre = encuadreDe([{ este: 10, norte: -4 }]);

    expect(encuadre.esteMax - encuadre.esteMin).toBeGreaterThanOrEqual(SPAN_MINIMO_M);
    expect(encuadre.norteMax - encuadre.norteMin).toBeGreaterThanOrEqual(SPAN_MINIMO_M);
    expect((encuadre.esteMin + encuadre.esteMax) / 2).toBeCloseTo(10, 6);
    expect((encuadre.norteMin + encuadre.norteMax) / 2).toBeCloseTo(-4, 6);
  });

  it('deja aire alrededor del contenido y lo contiene entero', () => {
    const posiciones = [
      { este: -200, norte: -150 },
      { este: 300, norte: 250 },
    ];
    const encuadre = encuadreDe(posiciones);

    expect(encuadre.esteMin).toBeLessThan(-200);
    expect(encuadre.esteMax).toBeGreaterThan(300);
    expect(encuadre.norteMin).toBeLessThan(-150);
    expect(encuadre.norteMax).toBeGreaterThan(250);
  });

  it('sin posiciones devuelve una caja válida y no NaN', () => {
    const encuadre = encuadreDe([]);

    expect(Number.isFinite(encuadre.esteMin)).toBe(true);
    expect(encuadre.esteMax - encuadre.esteMin).toBe(SPAN_MINIMO_M);
  });
});

describe('ajustarACaja y enPdf', () => {
  const CAJA = { x: 62, y: 300, ancho: 471, alto: 206 };

  it('conserva la proporción: un metro mide lo mismo en los dos ejes', () => {
    // Un encuadre ancho y bajo metido en una caja casi cuadrada. Si se estirara
    // para llenarla, la barra de escala dejaria de valer.
    const ajuste = ajustarACaja(
      { esteMin: -500, esteMax: 500, norteMin: -50, norteMax: 50 },
      CAJA,
    );

    expect(ajuste.escala).toBeGreaterThan(0);
    expect(ajuste.anchoPx / 1000).toBeCloseTo(ajuste.altoPx / 100, 6);
    expect(ajuste.anchoPx).toBeLessThanOrEqual(CAJA.ancho + 1e-6);
    expect(ajuste.altoPx).toBeLessThanOrEqual(CAJA.alto + 1e-6);
  });

  it('centra el contenido dentro de la caja', () => {
    const ajuste = ajustarACaja(
      { esteMin: -500, esteMax: 500, norteMin: -50, norteMax: 50 },
      CAJA,
    );

    expect(ajuste.x0 - CAJA.x).toBeCloseTo(CAJA.x + CAJA.ancho - (ajuste.x0 + ajuste.anchoPx), 6);
    expect(ajuste.y0 - CAJA.y).toBeCloseTo(CAJA.y + CAJA.alto - (ajuste.y0 + ajuste.altoPx), 6);
  });

  it('pone el norte arriba y el este a la derecha', () => {
    const encuadre = { esteMin: -100, esteMax: 100, norteMin: -100, norteMax: 100 };
    const ajuste = ajustarACaja(encuadre, CAJA);

    const norte = enPdf(ajuste, { este: 0, norte: 80 });
    const sur = enPdf(ajuste, { este: 0, norte: -80 });
    const este = enPdf(ajuste, { este: 80, norte: 0 });
    const oeste = enPdf(ajuste, { este: -80, norte: 0 });

    // En PDF la y crece hacia ABAJO: mas al norte = y mas chico.
    expect(norte.y).toBeLessThan(sur.y);
    expect(este.x).toBeGreaterThan(oeste.x);
  });

  it('todo lo que está dentro del encuadre cae dentro de la caja', () => {
    const encuadre = { esteMin: -100, esteMax: 100, norteMin: -60, norteMax: 60 };
    const ajuste = ajustarACaja(encuadre, CAJA);

    for (const posicion of [
      { este: -100, norte: 60 },
      { este: 100, norte: -60 },
      { este: 0, norte: 0 },
    ]) {
      const { x, y } = enPdf(ajuste, posicion);
      expect(x).toBeGreaterThanOrEqual(CAJA.x - 1e-6);
      expect(x).toBeLessThanOrEqual(CAJA.x + CAJA.ancho + 1e-6);
      expect(y).toBeGreaterThanOrEqual(CAJA.y - 1e-6);
      expect(y).toBeLessThanOrEqual(CAJA.y + CAJA.alto + 1e-6);
    }
  });
});

describe('barraEscala', () => {
  it('elige un largo redondo y que quepa en el plano', () => {
    for (const escala of [0.4, 1, 2.5, 8, 40]) {
      const barra = barraEscala(471, escala);
      const mantisa = barra.metros / 10 ** Math.floor(Math.log10(barra.metros));

      expect([1, 2, 5]).toContain(Math.round(mantisa));
      expect(barra.px).toBeGreaterThan(0);
      expect(barra.px).toBeLessThanOrEqual(471 * 0.29);
    }
  });
});

describe('construirMapaRecorrido · puntos de la ronda', () => {
  it('toma el estado del punto del informe y no lo recalcula', () => {
    // Verdad unica: si el mapa contara sus propios omitidos, el circulo y la
    // tabla de la pagina anterior podrian contradecirse.
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2, { omitido: true })],
        coordenadas: [
          coordenada('cp-1', RECINTO.lat, RECINTO.lng),
          coordenada('cp-2', RECINTO.lat + 0.0005, RECINTO.lng),
        ],
      }),
    );

    expect(mapa.hayDatos).toBe(true);
    expect(mapa.puntos.map((p) => [p.numero, p.omitido])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('un punto sin coordenada cargada se lista aparte, no se pierde en silencio', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng), coordenada('cp-2', null, null)],
      }),
    );

    expect(mapa.puntos.map((p) => p.numero)).toEqual([1]);
    expect(mapa.puntosSinCoordenada).toEqual([{ numero: 2, nombre: 'Punto 2' }]);
  });

  it('convierte los numeric que el driver entrega como string', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2)],
        coordenadas: [
          coordenada('cp-1', RECINTO.lat, RECINTO.lng),
          coordenada('cp-2', RECINTO.lat + 0.001, RECINTO.lng),
        ],
      }),
    );

    const separacion = Math.abs(mapa.puntos[0]!.norte - mapa.puntos[1]!.norte);
    expect(separacion).toBeCloseTo(GRADO_MILESIMO_M, 1);
  });

  it('descarta una coordenada fuera de rango en vez de deformar el mapa', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2)],
        coordenadas: [
          coordenada('cp-1', RECINTO.lat, RECINTO.lng),
          coordenada('cp-2', 999, 999),
        ],
      }),
    );

    expect(mapa.puntos).toHaveLength(1);
    expect(mapa.puntosSinCoordenada.map((p) => p.numero)).toEqual([2]);
  });
});

describe('construirMapaRecorrido · traza', () => {
  const puntos = [punto(1)];
  const coordenadas = [coordenada('cp-1', RECINTO.lat, RECINTO.lng)];

  it('deja fuera del dibujo las posiciones con error sobre el máximo del tenant', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos,
        coordenadas,
        maxErrorTrazaM: 50,
        traza: [
          traza(RECINTO.lat, RECINTO.lng, 0, 8),
          traza(RECINTO.lat + 0.02, RECINTO.lng, 1, 1800),
          traza(RECINTO.lat + 0.0002, RECINTO.lng, 2, 12),
        ],
      }),
    );

    expect(mapa.traza).toHaveLength(2);
    expect(mapa.trazaDescartadaPorError).toBe(1);
    expect(mapa.trazaTotalRegistrada).toBe(3);
  });

  it('la distancia total considera TODAS las posiciones guardadas', () => {
    // Tiene que coincidir con la que muestra el panel (GeoService.patrolTrack).
    // Un informe que diga 800 m y un panel que diga 1.200 m para la misma ronda
    // es una discusion con el cliente, no un detalle.
    const mapa = construirMapaRecorrido(
      entrada({
        puntos,
        coordenadas,
        maxErrorTrazaM: 50,
        traza: [
          traza(RECINTO.lat, RECINTO.lng, 0, 8),
          traza(RECINTO.lat + 0.001, RECINTO.lng, 1, 900),
        ],
      }),
    );

    expect(mapa.traza).toHaveLength(1);
    expect(mapa.distanciaTrazaM).toBeCloseTo(GRADO_MILESIMO_M, 0);
  });

  it('una posición sin dato de error se dibuja igual', () => {
    // accuracy_m es nullable: descartar por "no se sabe" borraria trazas
    // enteras de equipos que no reportan precision.
    const mapa = construirMapaRecorrido(
      entrada({ puntos, coordenadas, maxErrorTrazaM: 50, traza: [traza(RECINTO.lat, RECINTO.lng, 0)] }),
    );

    expect(mapa.traza).toHaveLength(1);
    expect(mapa.trazaDescartadaPorError).toBe(0);
  });

  it('submuestrea sobre el tope y conserva la primera y la última posición', () => {
    const filas = Array.from({ length: 10 }, (_, i) =>
      traza(RECINTO.lat + i * 0.0001, RECINTO.lng, i),
    );
    const mapa = construirMapaRecorrido(
      entrada({ puntos, coordenadas, traza: filas, maxPuntosTraza: 4 }),
    );

    expect(mapa.trazaSubmuestreada).toBe(true);
    expect(mapa.traza.length).toBeLessThanOrEqual(5);
    expect(mapa.traza[0]!.instante).toEqual(filas[0]!.recorded_at_device);
    expect(mapa.traza[mapa.traza.length - 1]!.instante).toEqual(filas[9]!.recorded_at_device);
  });

  it('bajo el tope no submuestrea nada', () => {
    const filas = Array.from({ length: 5 }, (_, i) =>
      traza(RECINTO.lat + i * 0.0001, RECINTO.lng, i),
    );
    const mapa = construirMapaRecorrido(entrada({ puntos, coordenadas, traza: filas }));

    expect(mapa.trazaSubmuestreada).toBe(false);
    expect(mapa.traza).toHaveLength(5);
  });
});

describe('construirMapaRecorrido · escaneos con anomalía de GPS', () => {
  const puntos = [punto(1)];
  const coordenadas = [coordenada('cp-1', RECINTO.lat, RECINTO.lng)];

  it('marca el escaneo fuera de radio en su posición real y mide la desviación', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos,
        coordenadas,
        escaneos: [
          escaneo('cp-1', {
            latitude: (RECINTO.lat + 0.001).toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['fuera_de_radio_gps'],
          }),
        ],
      }),
    );

    expect(mapa.escaneosDesviados).toHaveLength(1);
    expect(mapa.escaneosDesviados[0]!.numeroPunto).toBe(1);
    expect(mapa.escaneosDesviados[0]!.desviacionM).toBeCloseTo(GRADO_MILESIMO_M, 0);
  });

  it('un escaneo sin fix no tiene posición: se cuenta, no se inventa', () => {
    const mapa = construirMapaRecorrido(
      entrada({ puntos, coordenadas, escaneos: [escaneo('cp-1', { anomalies: ['sin_fix_gps'] })] }),
    );

    expect(mapa.escaneosDesviados).toEqual([]);
    expect(mapa.escaneosGpsSinPosicion).toBe(1);
  });

  it('las anomalías que no hablan de posición no se dibujan', () => {
    // reloj_desfasado y dispositivo_duplicado son senales validas, pero no
    // dicen donde estaba el telefono: en un mapa no significan nada.
    const mapa = construirMapaRecorrido(
      entrada({
        puntos,
        coordenadas,
        escaneos: [
          escaneo('cp-1', {
            latitude: (RECINTO.lat + 0.001).toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['reloj_desfasado', 'dispositivo_duplicado'],
          }),
        ],
      }),
    );

    expect(mapa.escaneosDesviados).toEqual([]);
    expect(mapa.escaneosGpsSinPosicion).toBe(0);
  });

  it('anomalies en null desde la base no revienta el mapa', () => {
    const mapa = construirMapaRecorrido(
      entrada({ puntos, coordenadas, escaneos: [escaneo('cp-1', { anomalies: null })] }),
    );

    expect(mapa.escaneosDesviados).toEqual([]);
  });

  it('un fix delirante no achica el recinto: queda fuera del plano y se informa', () => {
    // El caso real: el telefono entrega una posicion a kilometros. Si esa marca
    // entrara al encuadre, el recinto completo quedaria del tamano de un punto
    // y el informe perderia el mapa entero por una sola lectura mala.
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1), punto(2)],
        coordenadas: [
          coordenada('cp-1', RECINTO.lat, RECINTO.lng),
          coordenada('cp-2', RECINTO.lat + 0.0004, RECINTO.lng),
        ],
        escaneos: [
          escaneo('cp-2', {
            latitude: (RECINTO.lat + 0.05).toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['fuera_de_radio_gps'],
          }),
        ],
      }),
    );

    expect(mapa.escaneosDesviados).toEqual([]);
    expect(mapa.escaneosFueraDelPlano).toHaveLength(1);
    expect(mapa.escaneosFueraDelPlano[0]!.desviacionM).toBeGreaterThan(5000);
    // El encuadre sigue siendo del tamano del recinto, no del error del GPS.
    expect(mapa.encuadre.norteMax - mapa.encuadre.norteMin).toBeLessThan(200);
  });

  it('una desviación de cien metros SÍ se dibuja: es justo la que hay que mirar', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
        escaneos: [
          escaneo('cp-1', {
            latitude: (RECINTO.lat + 0.001).toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['fuera_de_radio_gps'],
          }),
        ],
      }),
    );

    expect(mapa.escaneosDesviados).toHaveLength(1);
    expect(mapa.escaneosFueraDelPlano).toEqual([]);
  });

  it('sin puntos ni recorrido, el escaneo desviado es lo único y se dibuja igual', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', null, null)],
        escaneos: [
          escaneo('cp-1', {
            latitude: RECINTO.lat.toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['fuera_de_radio_gps'],
          }),
        ],
      }),
    );

    expect(mapa.hayDatos).toBe(true);
    expect(mapa.escaneosDesviados).toHaveLength(1);
    expect(mapa.escaneosFueraDelPlano).toEqual([]);
  });

  it('un escaneo de un punto que no está en la ronda igual se dibuja, sin número', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos,
        coordenadas,
        escaneos: [
          escaneo('cp-fuera', {
            latitude: (RECINTO.lat + 0.001).toFixed(6),
            longitude: RECINTO.lng.toFixed(6),
            anomalies: ['fuera_de_radio_gps'],
          }),
        ],
      }),
    );

    expect(mapa.escaneosDesviados).toHaveLength(1);
    expect(mapa.escaneosDesviados[0]!.numeroPunto).toBeNull();
    expect(mapa.escaneosDesviados[0]!.desviacionM).toBeNull();
  });
});

describe('construirMapaRecorrido · sin nada que dibujar', () => {
  it('una ronda sin una sola coordenada devuelve el modelo con hayDatos en false', () => {
    const mapa = construirMapaRecorrido(
      entrada({ puntos: [punto(1), punto(2)], coordenadas: [coordenada('cp-1', null, null)] }),
    );

    expect(mapa.hayDatos).toBe(false);
    expect(mapa.puntosSinCoordenada).toHaveLength(2);
    expect(mapa.puntos).toEqual([]);
    expect(mapa.encuadre.esteMax).toBeGreaterThan(mapa.encuadre.esteMin);
  });

  it('avisa cuando la empresa no tiene activado el registro de recorrido', () => {
    const mapa = construirMapaRecorrido(entrada({ trazaActivada: false }));

    expect(mapa.trazaDesactivada).toBe(true);
    expect(mapa.hayDatos).toBe(false);
  });

  it('con la traza activada no marca la advertencia', () => {
    const mapa = construirMapaRecorrido(
      entrada({
        puntos: [punto(1)],
        coordenadas: [coordenada('cp-1', RECINTO.lat, RECINTO.lng)],
      }),
    );

    expect(mapa.trazaDesactivada).toBe(false);
    expect(mapa.hayDatos).toBe(true);
  });
});
