/**
 * Pruebas del calculo de los informes (#87).
 *
 * Lo que se prueba es lo que se rompe en silencio: un rango mal acotado que
 * termina en un 400 del servidor, una escala que deja la barra tocando el
 * borde, un promedio de promedios que miente, un dia que se corre por zona
 * horaria, y un CSV que ejecuta formulas al abrirlo.
 */

// Los globales se importan en vez de heredarse de `@types/jest`: `apps/web` no
// declara Jest entre sus dependencias —lo hereda del workspace— y con el tipado
// implicito el `typecheck` del panel se cae segun donde este instalado.
import { describe, expect, it } from '@jest/globals';

import {
  DIAS_POR_DEFECTO,
  TOPE_DIAS,
  TOPE_MAXIMO,
  agruparPorSucursal,
  anclaTexto,
  diasEntre,
  esDia,
  escalaAgradable,
  etiquetaBucket,
  etiquetaRango,
  formatearEntero,
  formatearPorcentaje,
  fraccion,
  graficasLimitadas,
  granularidadSugerida,
  hoyUtc,
  indicesEtiquetados,
  normalizarDia,
  opcionesDeRecinto,
  opcionesDeSucursal,
  posicionEtiqueta,
  posicionSerie,
  resolverRangoPanel,
  resumirCumplimiento,
  sumarDias,
  truncar,
  type RecintoCumplimiento,
} from './stats-charts-data';
import { escaparCampoCsv, nombreArchivoCsv } from './stats-charts-csv-format';

const HOY = '2026-08-03';

function recinto(parcial: Partial<RecintoCumplimiento> & { siteId: string }): RecintoCumplimiento {
  return {
    siteName: parcial.siteId,
    branchName: 'Centro',
    patrols: 0,
    completed: 0,
    incomplete: 0,
    expired: 0,
    open: 0,
    ratedPatrols: 0,
    compliancePct: null,
    belowThreshold: false,
    ...parcial,
  };
}

describe('topes de rango', () => {
  /**
   * Estos numeros son los de `apps/api/src/stats/stats-range.ts`. El panel los
   * duplica para poder frenar el rango ANTES de pedirlo; si alguien los mueve
   * alla y no aca, el usuario vuelve a ver el 400 crudo. Esta prueba es el
   * recordatorio.
   */
  it('coincide con los topes que impone la API', () => {
    expect(TOPE_DIAS.cumplimiento).toBe(731);
    expect(TOPE_DIAS.evolucion).toBe(731);
    expect(TOPE_DIAS.ranking).toBe(366);
    expect(TOPE_DIAS.omitidos).toBe(92);
    expect(TOPE_MAXIMO).toBe(731);
  });

  it('un trimestre no limita ninguna grafica', () => {
    expect(graficasLimitadas(92)).toEqual([]);
  });

  it('pasado el trimestre solo cae "puntos omitidos"', () => {
    expect(graficasLimitadas(93)).toEqual(['omitidos']);
  });

  it('pasado el año caen tambien el ranking', () => {
    expect(graficasLimitadas(400).sort()).toEqual(['omitidos', 'ranking']);
  });
});

describe('calendario', () => {
  it('reconoce dias validos y rechaza los que no existen', () => {
    expect(esDia('2026-08-03')).toBe(true);
    expect(esDia('2026-02-30')).toBe(false);
    expect(esDia('2026-8-3')).toBe(false);
    expect(esDia('ayer')).toBe(false);
    expect(esDia(undefined)).toBe(false);
  });

  it('cuenta los dias con los dos extremos incluidos, igual que la API', () => {
    expect(diasEntre('2026-08-03', '2026-08-03')).toBe(1);
    expect(diasEntre('2026-08-01', '2026-08-31')).toBe(31);
  });

  it('suma dias cruzando el cambio de mes y de año', () => {
    expect(sumarDias('2026-08-31', 1)).toBe('2026-09-01');
    expect(sumarDias('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('hoyUtc corta por el dia UTC, que es el mismo criterio del servidor', () => {
    expect(hoyUtc(Date.parse('2026-08-03T23:59:59.000Z'))).toBe('2026-08-03');
    expect(hoyUtc(Date.parse('2026-08-04T00:00:00.000Z'))).toBe('2026-08-04');
  });
});

describe('resolverRangoPanel', () => {
  it('sin parametros abre con el ultimo mes', () => {
    const rango = resolverRangoPanel(undefined, undefined, HOY);
    expect(rango).toEqual({ desde: '2026-07-05', hasta: HOY, dias: DIAS_POR_DEFECTO, ajustado: false });
  });

  it('respeta un rango valido', () => {
    const rango = resolverRangoPanel('2026-01-01', '2026-01-31', HOY);
    expect(rango).toEqual({ desde: '2026-01-01', hasta: '2026-01-31', dias: 31, ajustado: false });
  });

  it('no lanza con una URL escrita a mano: cae al default y lo avisa', () => {
    const rango = resolverRangoPanel('el-lunes', 'pasado', HOY);
    expect(rango.desde).toBe('2026-07-05');
    expect(rango.hasta).toBe(HOY);
    expect(rango.ajustado).toBe(true);
  });

  it('recorta un "hasta" futuro a hoy sin marcarlo como error del usuario', () => {
    const rango = resolverRangoPanel('2026-08-01', '2030-01-01', HOY);
    expect(rango.hasta).toBe(HOY);
    expect(rango.ajustado).toBe(false);
  });

  it('ignora un "desde" posterior al "hasta"', () => {
    const rango = resolverRangoPanel('2026-08-02', '2026-07-01', HOY);
    expect(rango.hasta).toBe('2026-07-01');
    expect(rango.desde).toBe('2026-06-02');
    expect(rango.ajustado).toBe(true);
  });

  /** El caso que motiva todo esto: la API responde 400 y el usuario ve un texto crudo. */
  it('acota a dos años el rango que la API rechazaria', () => {
    const rango = resolverRangoPanel('2000-01-01', HOY, HOY);
    expect(rango.dias).toBe(TOPE_MAXIMO);
    expect(rango.desde).toBe('2024-08-03');
    expect(diasEntre(rango.desde, rango.hasta)).toBe(TOPE_MAXIMO);
    expect(rango.ajustado).toBe(true);
  });

  it('deja pasar el rango de exactamente el tope', () => {
    const desde = sumarDias(HOY, -(TOPE_MAXIMO - 1));
    const rango = resolverRangoPanel(desde, HOY, HOY);
    expect(rango.dias).toBe(TOPE_MAXIMO);
    expect(rango.ajustado).toBe(false);
  });
});

describe('granularidad sugerida', () => {
  it('un mes se mira por dia, un semestre por semana y dos años por mes', () => {
    expect(granularidadSugerida(30)).toBe('dia');
    expect(granularidadSugerida(45)).toBe('dia');
    expect(granularidadSugerida(46)).toBe('semana');
    expect(granularidadSugerida(240)).toBe('semana');
    expect(granularidadSugerida(731)).toBe('mes');
  });
});

describe('normalizarDia', () => {
  it('deja pasar un dia que ya viene limpio', () => {
    expect(normalizarDia('2026-07-01')).toBe('2026-07-01');
  });

  /**
   * El driver de PostgreSQL convierte `date` a `Date` en la zona del PROCESO,
   * asi que el mismo dia llega como instantes distintos segun donde corra la
   * API. Redondear al dia UTC mas cercano lo devuelve bien en los tres casos.
   */
  it('devuelve el mismo dia corra la API en UTC, en Santiago o en Madrid', () => {
    expect(normalizarDia('2026-07-01T00:00:00.000Z')).toBe('2026-07-01');
    expect(normalizarDia('2026-07-01T04:00:00.000Z')).toBe('2026-07-01');
    expect(normalizarDia('2026-06-30T22:00:00.000Z')).toBe('2026-07-01');
  });

  it('no explota con basura: devuelve algo y no lanza', () => {
    expect(normalizarDia('no-es-fecha')).toBe('no-es-fech');
    expect(() => normalizarDia('')).not.toThrow();
  });
});

describe('escalas', () => {
  it('sube el techo al siguiente numero redondo para dejar sitio a la cifra', () => {
    expect(escalaAgradable(12)).toBe(15);
    expect(escalaAgradable(30)).toBe(30);
    expect(escalaAgradable(7)).toBe(8);
    expect(escalaAgradable(101)).toBe(150);
    expect(escalaAgradable(1)).toBe(1);
  });

  it('nunca devuelve cero, que dividiria por cero al dibujar', () => {
    expect(escalaAgradable(0)).toBe(1);
    expect(escalaAgradable(-5)).toBe(1);
    expect(escalaAgradable(Number.NaN)).toBe(1);
  });

  it('la fraccion queda siempre entre 0 y 1', () => {
    expect(fraccion(50, 100)).toBe(0.5);
    expect(fraccion(150, 100)).toBe(1);
    expect(fraccion(-3, 100)).toBe(0);
    expect(fraccion(5, 0)).toBe(0);
  });

  it('la cifra se escribe adentro solo cuando afuera se saldria del marco', () => {
    expect(posicionEtiqueta(0.5)).toBe('fuera');
    expect(posicionEtiqueta(0.82)).toBe('fuera');
    expect(posicionEtiqueta(0.83)).toBe('dentro');
  });

  it('el texto de una referencia se ancla para no salirse por los bordes', () => {
    expect(anclaTexto(2)).toBe('start');
    expect(anclaTexto(50)).toBe('middle');
    expect(anclaTexto(95)).toBe('end');
  });
});

describe('eje horizontal de la serie', () => {
  it('reparte el ancho completo entre el primer y el ultimo punto', () => {
    expect(posicionSerie(0, 5)).toBe(0);
    expect(posicionSerie(4, 5)).toBe(100);
    expect(posicionSerie(2, 5)).toBe(50);
  });

  it('centra el punto unico en vez de pegarlo al borde', () => {
    expect(posicionSerie(0, 1)).toBe(50);
  });

  it('con pocos puntos etiqueta todos', () => {
    expect(indicesEtiquetados(4)).toEqual([0, 1, 2, 3]);
  });

  it('con noventa dias etiqueta un puñado, siempre con el primero y el ultimo', () => {
    const indices = indicesEtiquetados(90);
    expect(indices.length).toBeLessThanOrEqual(6);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(89);
  });

  it('con la serie vacia no etiqueta nada', () => {
    expect(indicesEtiquetados(0)).toEqual([]);
  });
});

describe('textos', () => {
  it('recorta por palabra cuando puede', () => {
    expect(truncar('Bodega norte', 40)).toBe('Bodega norte');
    expect(truncar('Estacionamiento subterráneo nivel menos dos', 20)).toBe('Estacionamiento…');
  });

  it('escribe los porcentajes con coma decimal, como en Chile', () => {
    expect(formatearPorcentaje(82.4)).toBe('82,4%');
    expect(formatearPorcentaje(100)).toBe('100,0%');
  });

  /** "Sin dato" y "0,0%" son cosas distintas y no se pueden confundir. */
  it('distingue "sin dato" de cero', () => {
    expect(formatearPorcentaje(null)).toBe('Sin dato');
    expect(formatearPorcentaje(0)).toBe('0,0%');
  });

  it('formatea enteros con separador de miles', () => {
    expect(formatearEntero(1234)).toBe('1.234');
  });

  it('etiqueta cada punto segun la agrupacion', () => {
    expect(etiquetaBucket('2026-08-03', 'dia')).toBe('03 ago');
    expect(etiquetaBucket('2026-08-03', 'semana')).toBe('sem. 03 ago');
    expect(etiquetaBucket('2026-08-03', 'mes')).toBe('ago 2026');
  });

  it('describe el periodo en palabras para el encabezado', () => {
    expect(etiquetaRango({ desde: '2026-07-05', hasta: '2026-08-03' })).toBe(
      'del 5 de julio de 2026 al 3 de agosto de 2026',
    );
  });
});

describe('resumirCumplimiento', () => {
  /**
   * El punto de toda esta funcion: una bodega con 2 rondas al 100% no puede
   * pesar lo mismo que un mall con 200 al 60%. Promediando promedios daria 80%;
   * ponderado da 60,4%, que es lo que de verdad paso.
   */
  it('pondera por ronda evaluada y no promedia promedios', () => {
    const resumen = resumirCumplimiento([
      recinto({ siteId: 'mall', patrols: 200, ratedPatrols: 200, compliancePct: 60 }),
      recinto({ siteId: 'bodega', patrols: 2, ratedPatrols: 2, compliancePct: 100 }),
    ]);
    expect(resumen.promedio).toBe(60.4);
    expect(resumen.rondas).toBe(202);
    expect(resumen.recintos).toBe(2);
  });

  it('un recinto sin cumplimiento calculado no arrastra el promedio a cero', () => {
    const resumen = resumirCumplimiento([
      recinto({ siteId: 'a', patrols: 10, ratedPatrols: 10, compliancePct: 90 }),
      recinto({ siteId: 'b', patrols: 4, ratedPatrols: 0, compliancePct: null }),
    ]);
    expect(resumen.promedio).toBe(90);
    expect(resumen.rondas).toBe(14);
  });

  it('sin ninguna ronda evaluada el promedio es nulo, no cero', () => {
    const resumen = resumirCumplimiento([recinto({ siteId: 'a', patrols: 3 })]);
    expect(resumen.promedio).toBeNull();
    expect(resumen.peor).toBeNull();
  });

  it('cuenta los recintos bajo umbral y señala el peor', () => {
    const resumen = resumirCumplimiento([
      recinto({ siteId: 'a', ratedPatrols: 5, compliancePct: 55, belowThreshold: true }),
      recinto({ siteId: 'b', ratedPatrols: 5, compliancePct: 95 }),
      recinto({ siteId: 'c', ratedPatrols: 5, compliancePct: 40, belowThreshold: true }),
    ]);
    expect(resumen.bajoUmbral).toBe(2);
    expect(resumen.peor?.siteId).toBe('c');
  });
});

describe('agruparPorSucursal', () => {
  it('junta los recintos de la misma sucursal y pondera por ronda', () => {
    const grupos = agruparPorSucursal([
      recinto({ siteId: 'a', branchName: 'Norte', patrols: 10, ratedPatrols: 10, compliancePct: 50 }),
      recinto({ siteId: 'b', branchName: 'Norte', patrols: 30, ratedPatrols: 30, compliancePct: 90 }),
      recinto({ siteId: 'c', branchName: 'Sur', patrols: 5, ratedPatrols: 5, compliancePct: 95 }),
    ]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0]).toMatchObject({ sucursal: 'Norte', recintos: 2, rondas: 40, promedio: 80 });
    expect(grupos[1]).toMatchObject({ sucursal: 'Sur', promedio: 95 });
  });

  /** Al panel se entra a buscar el problema: la peor sucursal va primero. */
  it('ordena de peor a mejor y deja al final las que no tienen dato', () => {
    const grupos = agruparPorSucursal([
      recinto({ siteId: 'a', branchName: 'Buena', ratedPatrols: 1, compliancePct: 99 }),
      recinto({ siteId: 'b', branchName: 'Sin datos' }),
      recinto({ siteId: 'c', branchName: 'Mala', ratedPatrols: 1, compliancePct: 41 }),
    ]);
    expect(grupos.map((grupo) => grupo.sucursal)).toEqual(['Mala', 'Buena', 'Sin datos']);
  });
});

describe('opciones de filtro', () => {
  it('arma la lista de recintos ordenada por sucursal y nombre', () => {
    const opciones = opcionesDeRecinto([
      recinto({ siteId: '2', siteName: 'Zeta', branchName: 'Norte' }),
      recinto({ siteId: '1', siteName: 'Alfa', branchName: 'Norte' }),
      recinto({ siteId: '3', siteName: 'Beta', branchName: 'Centro' }),
    ]);
    expect(opciones.map((opcion) => opcion.id)).toEqual(['3', '1', '2']);
  });

  it('lista cada sucursal una sola vez', () => {
    expect(
      opcionesDeSucursal([
        recinto({ siteId: 'a', branchName: 'Norte' }),
        recinto({ siteId: 'b', branchName: 'Norte' }),
        recinto({ siteId: 'c', branchName: 'Centro' }),
      ]),
    ).toEqual(['Centro', 'Norte']);
  });
});

describe('CSV', () => {
  it('encierra los campos con punto y coma, comillas o saltos de linea', () => {
    expect(escaparCampoCsv('Bodega norte')).toBe('Bodega norte');
    expect(escaparCampoCsv('Recinto; anexo')).toBe('"Recinto; anexo"');
    expect(escaparCampoCsv('El "anexo"')).toBe('"El ""anexo"""');
  });

  /**
   * Los nombres de recintos y guardias los escribe el cliente. Un recinto
   * llamado `=HYPERLINK(...)` se EJECUTA al abrir el CSV en Excel: el apostrofo
   * lo deja como texto.
   */
  it('neutraliza los campos que Excel interpretaria como formula', () => {
    expect(escaparCampoCsv('=1+1')).toBe("'=1+1");
    expect(escaparCampoCsv('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escaparCampoCsv('-Bodega')).toBe("'-Bodega");
    expect(escaparCampoCsv('+7')).toBe("'+7");
  });

  it('arma un nombre de archivo sin acentos ni espacios', () => {
    expect(nombreArchivoCsv('Ranking de guardías', new Date('2026-08-03T10:00:00Z'))).toBe(
      'ranking-de-guardias-2026-08-03.csv',
    );
  });
});
