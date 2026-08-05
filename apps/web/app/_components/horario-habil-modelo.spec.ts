/**
 * Pruebas de la logica del horario habil del panel (#68).
 *
 * Cada caso esta escrito contra el predicado del SQL de
 * EvidenceService.isWithinBusinessHours(), no contra lo que "parece razonable":
 * si el servidor cambia, estas pruebas tienen que fallar.
 */
import {
  coberturaDelDia,
  descripcionTramo,
  diaDeLaSemana,
  diasSinCobertura,
  errorDelTramo,
  evaluarHorarioLocal,
  proximoDiaDeSemana,
  sumarDias,
  type FeriadoRecinto,
  type TramoHorario,
} from './horario-habil-modelo';

const VIERNES = 5;
const SABADO = 6;

/** Turno nocturno del viernes: 22:00 del viernes a 06:00 del sabado. */
const NOCTURNO_VIERNES: TramoHorario = { weekday: VIERNES, opensAt: '22:00', closesAt: '06:00' };
const DIURNO_SABADO: TramoHorario = { weekday: SABADO, opensAt: '09:00', closesAt: '18:00' };

// 2026-08-08 es sabado; 2026-08-07 es viernes.
const SABADO_FECHA = '2026-08-08';

describe('cobertura y medianoche', () => {
  it('el tramo nocturno del viernes cubre la madrugada del sábado', () => {
    const cobertura = coberturaDelDia(SABADO, [NOCTURNO_VIERNES]);
    expect(cobertura).toEqual([
      { desde: '00:00', hasta: '06:00', origen: VIERNES, heredada: true },
    ]);
  });

  it('y el viernes queda cubierto solo desde las 22:00 hasta el fin del día', () => {
    expect(coberturaDelDia(VIERNES, [NOCTURNO_VIERNES])).toEqual([
      { desde: '22:00', hasta: '24:00', origen: VIERNES, heredada: false },
    ]);
  });

  it('un tramo normal no derrama nada sobre el día siguiente', () => {
    expect(coberturaDelDia(0, [DIURNO_SABADO])).toEqual([]);
    expect(coberturaDelDia(SABADO, [DIURNO_SABADO])).toEqual([
      { desde: '09:00', hasta: '18:00', origen: SABADO, heredada: false },
    ]);
  });

  it('un día puede tener franja heredada y franja propia a la vez', () => {
    const cobertura = coberturaDelDia(SABADO, [NOCTURNO_VIERNES, DIURNO_SABADO]);
    expect(cobertura.map((franja) => `${franja.desde}-${franja.hasta}`)).toEqual([
      '00:00-06:00',
      '09:00-18:00',
    ]);
  });

  it('un cierre a las 00:00 no genera franja vacía en el día siguiente', () => {
    const cobertura = coberturaDelDia(0, [{ weekday: SABADO, opensAt: '20:00', closesAt: '00:00' }]);
    expect(cobertura).toEqual([]);
  });

  it('los días sin fila quedan enteros fuera de horario', () => {
    // Solo el viernes tiene fila; el sabado igual queda "cubierto" de madrugada.
    expect(diasSinCobertura([NOCTURNO_VIERNES])).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('validación previa (la misma que devuelve 400 en el servidor)', () => {
  it('apertura igual a cierre no es un día de 24 horas: es un error', () => {
    expect(errorDelTramo({ weekday: 1, opensAt: '08:00', closesAt: '08:00' })).toMatch(
      /no pueden ser iguales/,
    );
  });

  it('un tramo válido no reporta error', () => {
    expect(errorDelTramo(NOCTURNO_VIERNES)).toBeNull();
    expect(errorDelTramo(DIURNO_SABADO)).toBeNull();
  });

  it('un tramo inválido no aporta cobertura', () => {
    expect(coberturaDelDia(1, [{ weekday: 1, opensAt: '08:00', closesAt: '08:00' }])).toEqual([]);
  });
});

describe('evaluarHorarioLocal', () => {
  const evaluar = (
    tramos: TramoHorario[],
    feriados: FeriadoRecinto[],
    fecha: string,
    hora: string,
  ) => evaluarHorarioLocal({ tramos, feriados, fecha, hora });

  it('sábado 03:00 con horario de oficina: fuera de horario', () => {
    const resultado = evaluar([DIURNO_SABADO], [], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('no-habil');
  });

  it('sábado 03:00 con turno nocturno del viernes: hábil, y lo dice', () => {
    const resultado = evaluar([NOCTURNO_VIERNES], [], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('habil');
    expect(resultado.franja?.heredada).toBe(true);
    expect(resultado.motivo).toContain('viernes');
  });

  it('el límite superior es exclusivo: 06:00 ya está fuera', () => {
    expect(evaluar([NOCTURNO_VIERNES], [], SABADO_FECHA, '06:00').veredicto).toBe('no-habil');
    expect(evaluar([NOCTURNO_VIERNES], [], SABADO_FECHA, '05:59').veredicto).toBe('habil');
  });

  it('el límite inferior es inclusivo: 22:00 del viernes ya está dentro', () => {
    expect(evaluar([NOCTURNO_VIERNES], [], '2026-08-07', '22:00').veredicto).toBe('habil');
    expect(evaluar([NOCTURNO_VIERNES], [], '2026-08-07', '21:59').veredicto).toBe('no-habil');
  });

  it('un feriado del sábado apaga incluso la madrugada que venía del viernes', () => {
    const feriado = { date: SABADO_FECHA, name: 'Cierre por mantención' };
    const resultado = evaluar([NOCTURNO_VIERNES], [feriado], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('no-habil');
    expect(resultado.feriado).toEqual(feriado);
  });

  it('un feriado del viernes NO apaga la madrugada del sábado', () => {
    // El SQL compara el feriado contra la fecha local del INSTANTE, que a las
    // 03:00 del sabado ya es sabado. Contraintuitivo pero es lo que corre.
    const resultado = evaluar([NOCTURNO_VIERNES], [{ date: '2026-08-07', name: null }], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('habil');
  });

  it('sin feriado, el sábado a las 10:00 cae en su propio tramo', () => {
    expect(evaluar([DIURNO_SABADO], [], SABADO_FECHA, '10:00').veredicto).toBe('habil');
  });

  it('recinto sin horario: no inventa un veredicto, señala la regla del tenant', () => {
    const resultado = evaluar([], [], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('sin-horario');
    expect(resultado.motivo).toContain('Recinto sin horario cargado cuenta como abierto');
  });

  it('un feriado ya es configuración suficiente aunque no haya horario semanal', () => {
    const resultado = evaluar([], [{ date: SABADO_FECHA, name: null }], SABADO_FECHA, '03:00');
    expect(resultado.veredicto).toBe('no-habil');
  });

  it('una fecha imposible no se evalúa como si fuera válida', () => {
    expect(evaluar([DIURNO_SABADO], [], '2026-02-30', '10:00').veredicto).toBe('sin-horario');
  });
});

describe('fechas locales sin husos', () => {
  it('diaDeLaSemana no depende del huso del navegador', () => {
    expect(diaDeLaSemana(SABADO_FECHA)).toBe(SABADO);
    expect(diaDeLaSemana('2026-08-07')).toBe(VIERNES);
    expect(diaDeLaSemana('2026-13-01')).toBeNull();
  });

  it('sumarDias cruza el cambio de horario de verano de Chile sin correrse', () => {
    // En Chile el reloj se mueve la madrugada del 2026-09-06.
    expect(sumarDias('2026-09-05', 1)).toBe('2026-09-06');
    expect(sumarDias('2026-09-06', 1)).toBe('2026-09-07');
    expect(sumarDias('2026-04-04', 1)).toBe('2026-04-05');
  });

  it('sumarDias cruza fin de mes y fin de año', () => {
    expect(sumarDias('2026-08-31', 1)).toBe('2026-09-01');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-08-08', -1)).toBe('2026-08-07');
  });

  it('proximoDiaDeSemana devuelve hoy si hoy ya es ese día', () => {
    expect(proximoDiaDeSemana(SABADO_FECHA, SABADO)).toBe(SABADO_FECHA);
    expect(proximoDiaDeSemana('2026-08-04', SABADO)).toBe(SABADO_FECHA);
  });
});

describe('texto del editor', () => {
  it('un tramo nocturno se lee con el día en que termina', () => {
    expect(descripcionTramo(NOCTURNO_VIERNES)).toBe('22:00 → 06:00 del sábado');
    expect(descripcionTramo(DIURNO_SABADO)).toBe('09:00 → 18:00');
  });
});
