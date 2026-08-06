import {
  analizarTraza,
  type FilaTrazaCruda,
  type ParametrosTraza,
} from './traza-analisis';

/**
 * Umbrales de los casos, elegidos para que los ejemplos se lean en minutos
 * redondos: hueco desde 5 min, detencion desde 5 min dentro de 25 m, precision
 * maxima 100 m.
 *
 * NO son los que aplica el servidor con la configuracion por defecto —esos son
 * 600 s por el piso de dos intervalos de muestreo, y los fija
 * `traza-metricas.service.spec.ts`—. Aca la funcion es pura y el umbral es un
 * parametro: mezclar las dos cosas obligaria a reescribir todos los casos cada
 * vez que cambia un default.
 */
const PARAMETROS: ParametrosTraza = {
  maxAccuracyM: 100,
  gapMinSeconds: 300,
  stopRadiusM: 25,
  stopMinSeconds: 300,
};

const BASE_LAT = -33.45;
const BASE_LNG = -70.66;
const T0 = new Date('2026-08-01T22:00:00Z').getTime();

const en = (minuto: number) => new Date(T0 + minuto * 60_000);

/**
 * `norte` son pasos de 0.0009 grados de latitud, que a esta latitud son ~100 m.
 * Las coordenadas van como STRING porque asi entrega numeric el driver.
 */
function fila(
  minuto: number,
  norte = 0,
  extra: { accuracy?: number | null; battery?: number | null } = {},
): FilaTrazaCruda {
  return {
    recorded_at_device: en(minuto),
    latitude: (BASE_LAT + norte * 0.0009).toFixed(6),
    longitude: BASE_LNG.toFixed(6),
    accuracy_m: extra.accuracy === undefined ? '8.00' : extra.accuracy?.toFixed(2) ?? null,
    battery_pct: extra.battery === undefined ? null : extra.battery,
  };
}

const analizar = (filas: FilaTrazaCruda[], entrada: { desde?: Date; hasta?: Date } = {}) =>
  analizarTraza({ filas, parametros: PARAMETROS, ...entrada });

describe('analizarTraza — distancia (#134)', () => {
  it('suma la distancia entre posiciones consecutivas', () => {
    const analisis = analizar([fila(0, 0), fila(1, 1), fila(2, 2)]);

    expect(analisis.points).toBe(3);
    expect(analisis.usablePoints).toBe(3);
    expect(analisis.distanceM).toBeGreaterThan(195);
    expect(analisis.distanceM).toBeLessThan(205);
    expect(analisis.measuredDistanceM).toBe(analisis.distanceM);
    expect(analisis.gapDistanceM).toBe(0);
  });

  it('una posicion imprecisa NO suma distancia, pero se conserva y se cuenta', () => {
    // El punto del medio dice estar a 2 km con 900 m de error: es ruido de
    // subterraneo. Si sumara, la ronda mediria 4 km en vez de 100 m.
    const analisis = analizar([
      fila(0, 0),
      fila(1, 20, { accuracy: 900 }),
      fila(2, 1),
    ]);

    expect(analisis.points).toBe(3);
    expect(analisis.usablePoints).toBe(2);
    expect(analisis.lowAccuracyPoints).toBe(1);
    expect(analisis.distanceM).toBeGreaterThan(95);
    expect(analisis.distanceM).toBeLessThan(105);
  });

  it('una posicion sin precision informada se trata como utilizable', () => {
    const analisis = analizar([fila(0, 0, { accuracy: null }), fila(1, 1, { accuracy: null })]);

    expect(analisis.usablePoints).toBe(2);
    expect(analisis.lowAccuracyPoints).toBe(0);
  });

  it('separa la distancia que cruza un hueco de la medida de verdad', () => {
    const analisis = analizar([fila(0, 0), fila(1, 1), fila(40, 5)]);

    expect(analisis.gapCount).toBe(1);
    // Los primeros 100 m se midieron; los otros 400 son una linea recta sobre
    // 39 minutos sin datos.
    expect(analisis.measuredDistanceM).toBeGreaterThan(95);
    expect(analisis.measuredDistanceM).toBeLessThan(105);
    expect(analisis.gapDistanceM).toBeGreaterThan(395);
    expect(analisis.distanceM).toBeCloseTo(
      analisis.measuredDistanceM + analisis.gapDistanceM,
      1,
    );
  });

  it('ordena la serie aunque las filas lleguen desordenadas', () => {
    const analisis = analizar([fila(2, 2), fila(0, 0), fila(1, 1)]);

    expect(analisis.firstPointAt).toEqual(en(0));
    expect(analisis.lastPointAt).toEqual(en(2));
    expect(analisis.distanceM).toBeLessThan(205);
  });

  it('descarta filas con coordenadas imposibles en vez de propagar NaN', () => {
    const rota: FilaTrazaCruda = {
      recorded_at_device: en(1),
      latitude: '999.000000',
      longitude: '-70.660000',
      accuracy_m: null,
      battery_pct: null,
    };
    const analisis = analizar([fila(0, 0), rota, fila(2, 1)]);

    expect(analisis.points).toBe(2);
    expect(Number.isFinite(analisis.distanceM)).toBe(true);
  });
});

describe('analizarTraza — huecos de cobertura (#134)', () => {
  it('marca como hueco el tramo sin reportes y dice cuanto duro', () => {
    const analisis = analizar([fila(0, 0), fila(40, 1)]);

    expect(analisis.gapCount).toBe(1);
    expect(analisis.gaps[0]?.minutes).toBe(40);
    expect(analisis.gaps[0]?.cause).toBe('sin_reporte');
    expect(analisis.gaps[0]?.lowAccuracyPoints).toBe(0);
    expect(analisis.longestGapMinutes).toBe(40);
  });

  it('un tramo mas corto que el umbral no es hueco', () => {
    const analisis = analizar([fila(0, 0), fila(4, 1)]);

    expect(analisis.gapCount).toBe(0);
  });

  it('las posiciones imprecisas de adentro EXPLICAN el hueco', () => {
    // El telefono nunca dejo de reportar: reporto mal. No es lo mismo que un
    // guardia que apago el equipo, y el informe tiene que poder distinguirlo.
    const analisis = analizar([
      fila(0, 0),
      fila(10, 3, { accuracy: 400 }),
      fila(20, 4, { accuracy: 650 }),
      fila(40, 1),
    ]);

    expect(analisis.gapCount).toBe(1);
    expect(analisis.gaps[0]?.cause).toBe('precision_insuficiente');
    expect(analisis.gaps[0]?.lowAccuracyPoints).toBe(2);
    expect(analisis.lowAccuracyPoints).toBe(2);
  });

  it('adjunta la bateria de los dos bordes del hueco', () => {
    const analisis = analizar([
      fila(0, 0, { battery: 40 }),
      fila(1, 1, { battery: 4 }),
      fila(50, 2, { battery: 96 }),
    ]);

    expect(analisis.gaps[0]?.batteryPctBefore).toBe(4);
    expect(analisis.gaps[0]?.batteryPctAfter).toBe(96);
  });

  it('con la ventana de la ronda aparecen el hueco de cabeza y el de cola', () => {
    const analisis = analizar([fila(30, 0), fila(31, 1)], {
      desde: en(0),
      hasta: en(60),
    });

    expect(analisis.gapCount).toBe(2);
    expect(analisis.gaps[0]?.fromAt).toEqual(en(0));
    expect(analisis.gaps[0]?.minutes).toBe(30);
    expect(analisis.gaps[0]?.straightLineM).toBeNull();
    expect(analisis.gaps[1]?.toAt).toEqual(en(60));
    expect(analisis.windowMinutes).toBe(60);
  });

  it('sin ninguna posicion utilizable, la ronda completa es un solo hueco', () => {
    const analisis = analizar(
      [fila(10, 0, { accuracy: 300 }), fila(20, 1, { accuracy: 300 })],
      { desde: en(0), hasta: en(60) },
    );

    expect(analisis.usablePoints).toBe(0);
    expect(analisis.gapCount).toBe(1);
    expect(analisis.gaps[0]?.cause).toBe('precision_insuficiente');
    expect(analisis.gaps[0]?.lowAccuracyPoints).toBe(2);
    expect(analisis.distanceM).toBe(0);
    expect(analisis.timeCoveragePct).toBe(0);
  });

  it('la cobertura es el porcentaje de la ventana con posicion utilizable', () => {
    // 60 minutos de ventana con muestreo seguido, salvo entre el minuto 20 y el
    // 50: 30 minutos sin saber donde estaba, la mitad de la ronda.
    const minutos = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 50, 52, 54, 56, 58, 60];
    const analisis = analizar(minutos.map((minuto, indice) => fila(minuto, indice)));

    expect(analisis.windowMinutes).toBe(60);
    expect(analisis.gapCount).toBe(1);
    expect(analisis.gapMinutes).toBe(30);
    expect(analisis.timeCoveragePct).toBe(50);
  });

  it('sin puntos no inventa ventana ni cobertura', () => {
    const analisis = analizar([]);

    expect(analisis.points).toBe(0);
    expect(analisis.gapCount).toBe(0);
    expect(analisis.distanceM).toBe(0);
    expect(analisis.timeCoveragePct).toBeNull();
    expect(analisis.windowFrom).toBeNull();
  });

  it('la ventana se estira si un punto llega despues del cierre de la ronda', () => {
    const analisis = analizar([fila(0, 0), fila(1, 1), fila(70, 2)], {
      desde: en(0),
      hasta: en(60),
    });

    expect(analisis.windowTo).toEqual(en(70));
    expect(analisis.lastPointAt).toEqual(en(70));
  });
});

describe('analizarTraza — tiempo detenido (#134)', () => {
  it('declara detencion cuando no se sale del radio por mas del minimo', () => {
    const filas = [0, 2, 4, 6, 8, 10].map((minuto) => fila(minuto, 0));
    const analisis = analizar(filas);

    expect(analisis.stopCount).toBe(1);
    expect(analisis.stops[0]?.minutes).toBe(10);
    expect(analisis.stops[0]?.points).toBe(6);
    expect(analisis.stoppedMinutes).toBe(10);
    expect(analisis.movingMinutes).toBe(0);
  });

  it('caminar no es estar detenido', () => {
    const filas = [0, 2, 4, 6, 8, 10].map((minuto, indice) => fila(minuto, indice));
    const analisis = analizar(filas);

    expect(analisis.stopCount).toBe(0);
    expect(analisis.stoppedMinutes).toBe(0);
    expect(analisis.movingMinutes).toBe(10);
  });

  it('una parada mas corta que el minimo no cuenta', () => {
    const analisis = analizar([fila(0, 0), fila(2, 0), fila(4, 0), fila(6, 3)]);

    expect(analisis.stopCount).toBe(0);
  });

  it('un hueco corta la ventana: no se cuenta como detenido lo que no se sabe', () => {
    // Mismo lugar antes y despues de 36 minutos sin datos. Sin el corte, esto
    // se leeria como una detencion de 44 minutos que nadie puede afirmar.
    const analisis = analizar([
      fila(0, 0),
      fila(2, 0),
      fila(4, 0),
      fila(40, 0),
      fila(42, 0),
      fila(44, 0),
    ]);

    expect(analisis.gapCount).toBe(1);
    expect(analisis.stopCount).toBe(0);
    expect(analisis.stoppedMinutes).toBe(0);
  });

  it('detecta dos detenciones separadas por un tramo caminando', () => {
    const filas = [
      fila(0, 0),
      fila(2, 0),
      fila(4, 0),
      fila(6, 0),
      fila(8, 3),
      fila(10, 6),
      fila(12, 9),
      fila(14, 9),
      fila(16, 9),
      fila(18, 9),
      fila(20, 9),
    ];
    const analisis = analizar(filas);

    expect(analisis.stopCount).toBe(2);
    expect(analisis.stops[0]?.minutes).toBe(6);
    expect(analisis.stops[1]?.minutes).toBe(8);
    expect(analisis.stops[0]?.latitude).toBeCloseTo(BASE_LAT, 6);
  });

  it('las posiciones imprecisas no crean ni rompen detenciones', () => {
    const filas = [
      fila(0, 0),
      fila(2, 0),
      fila(4, 40, { accuracy: 800 }),
      fila(6, 0),
      fila(8, 0),
      fila(10, 0),
    ];
    const analisis = analizar(filas);

    expect(analisis.stopCount).toBe(1);
    expect(analisis.stops[0]?.minutes).toBe(10);
    expect(analisis.stops[0]?.points).toBe(5);
  });

  it('los umbrales aplicados viajan en la respuesta para poder auditar el numero', () => {
    expect(analizar([]).thresholds).toEqual(PARAMETROS);
  });
});
