import {
  elegirVencimiento,
  evaluarTareaDelTurno,
  type CandidatosDeVencimiento,
  type VentanaDelTurno,
} from './tarea-atrasada.policy';

/**
 * Instante de una hora local de Santiago en INVIERNO (UTC-4).
 *
 * El offset fijo vive solo aca, en la fixture, y es correcto justamente porque
 * las fechas elegidas son de agosto: en produccion nadie escribe un offset, la
 * conversion la hace PostgreSQL con `AT TIME ZONE sites.timezone`. Escribirlo en
 * el codigo seria el error que documenta `scheduling.service.ts`.
 */
function local(fecha: string, hora: string): Date {
  return new Date(`${fecha}T${hora}:00-04:00`);
}

/**
 * El turno del ejemplo real: 22:00 a 06:00 del viernes 7 de agosto de 2026, o
 * sea la ronda que empieza el viernes y termina el sabado. `service_date` es el
 * VIERNES aunque la mitad del turno ocurra el sabado — el turno es el
 * contenedor (`app_stats_service_day`).
 */
const TURNO_NOCTURNO: VentanaDelTurno = {
  inicio: local('2026-08-07', '22:00'),
  fin: local('2026-08-08', '06:00'),
};

/** Lo que devuelve PostgreSQL para una hora de pared anclada al dia del turno. */
function candidatos(hora: string): CandidatosDeVencimiento {
  return {
    delDia: local('2026-08-07', hora),
    delDiaSiguiente: local('2026-08-08', hora),
  };
}

describe('tarea atrasada — turno que cruza medianoche (#265)', () => {
  it('tarea de las 23:00 respondida a las 02:00 del dia siguiente son 3 h, no 21', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '02:00'),
    });

    expect(veredicto.minutosDeAtraso).toBe(180);
    expect(veredicto.vencimiento).toEqual(local('2026-08-07', '23:00'));
    expect(veredicto.fueraDelTurno).toBe(false);
  });

  it('tarea de las 02:00 se ancla al dia SIGUIENTE: 30 min de atraso, no 24 h y media', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('02:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '02:30'),
    });

    expect(veredicto.minutosDeAtraso).toBe(30);
    expect(veredicto.vencimiento).toEqual(local('2026-08-08', '02:00'));
  });

  it('responder en la hora exacta no es atraso', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-07', '23:00'),
    });

    expect(veredicto.minutosDeAtraso).toBe(0);
    expect(veredicto.mensaje).toBeNull();
  });

  it('adelantarse no da credito: 0 minutos, nunca negativo', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-07', '22:10'),
    });

    // El CHECK de checklist_responses solo acepta NULL o >= 0.
    expect(veredicto.minutosDeAtraso).toBe(0);
  });

  it('30 segundos de atraso son 1 min, no 0', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: new Date(local('2026-08-07', '23:00').getTime() + 30_000),
    });

    expect(veredicto.minutosDeAtraso).toBe(1);
  });
});

describe('tarea atrasada — sin hora pedida (#265)', () => {
  it('una tarea sin hora no tiene atraso, y eso NO es cero', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: null,
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '05:00'),
    });

    expect(veredicto.minutosDeAtraso).toBeNull();
    expect(veredicto.vencimiento).toBeNull();
    expect(veredicto.mensaje).toBeNull();
  });
});

describe('tarea atrasada — la tarea que cae fuera del horario de la ronda (#265)', () => {
  it('la tarea de las 11:00 en un turno nocturno se acepta y se marca', () => {
    const veredicto = evaluarTareaDelTurno({
      candidatos: candidatos('11:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '05:00'),
    });

    expect(veredicto.fueraDelTurno).toBe(true);
    expect(veredicto.mensaje).toContain('fuera del horario de la ronda');
    // Ni una excepcion ni un rechazo: el veredicto es un numero y un texto.
    expect(veredicto.minutosDeAtraso).not.toBeNull();
  });

  it('se ancla al candidato mas cercano al TURNO, no al mas cercano a la respuesta', () => {
    // 11:00 con turno de 22:00 a 06:00: el candidato del dia esta 11 h antes del
    // inicio y el del dia siguiente 5 h despues del fin. Gana el segundo.
    const elegido = elegirVencimiento(candidatos('11:00'), TURNO_NOCTURNO);

    expect(elegido.at).toEqual(local('2026-08-08', '11:00'));
    expect(elegido.dentroDelTurno).toBe(false);
  });

  it('responder mas tarde NO corre el vencimiento: el atraso crece', () => {
    const tarde = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '02:00'),
    });
    const muchoMasTarde = evaluarTareaDelTurno({
      candidatos: candidatos('23:00'),
      ventana: TURNO_NOCTURNO,
      respondidaA: local('2026-08-08', '05:00'),
    });

    expect(muchoMasTarde.vencimiento).toEqual(tarde.vencimiento);
    expect(muchoMasTarde.minutosDeAtraso).toBe(360);
  });
});

describe('tarea atrasada — cambio de horario (#265)', () => {
  it('si la ventana de 25 h contiene los dos candidatos, gana el primero', () => {
    // La noche del retroceso: el turno dura una hora reloj mas y la misma hora de
    // pared alcanza a ocurrir en los dos dias que toca la ventana.
    const ventana: VentanaDelTurno = {
      inicio: new Date('2026-04-04T22:00:00Z'),
      fin: new Date('2026-04-05T23:00:00Z'),
    };
    const dosDentro: CandidatosDeVencimiento = {
      delDia: new Date('2026-04-04T23:00:00Z'),
      delDiaSiguiente: new Date('2026-04-05T23:00:00Z'),
    };

    const veredicto = evaluarTareaDelTurno({
      candidatos: dosDentro,
      ventana,
      respondidaA: new Date('2026-04-05T01:00:00Z'),
    });

    expect(veredicto.vencimiento).toEqual(new Date('2026-04-04T23:00:00Z'));
    expect(veredicto.minutosDeAtraso).toBe(120);
  });
});
