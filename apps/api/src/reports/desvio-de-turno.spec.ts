import { desvioDeTurno, redactarAtrasoDeTarea } from './desvio-de-turno';

/** Turno de tarde: 14:00 a 22:00 del 8 de agosto. */
const VENTANA = {
  desde: new Date('2026-08-08T14:00:00.000Z'),
  hasta: new Date('2026-08-08T22:00:00.000Z'),
};

describe('desvioDeTurno', () => {
  it('EL CASO: el guardia de la tarde marca 10 minutos despues del cierre', () => {
    // El requisito literal del dueño del producto. Antes de esto el informe
    // mostraba "22:10" y la resta la hacia el supervisor a mano, en cada punto.
    const desvio = desvioDeTurno(new Date('2026-08-08T22:10:00.000Z'), VENTANA);
    expect(desvio).toEqual({
      minutos: 10,
      borde: 'despues_del_cierre',
      texto: '10 min después del cierre del turno',
    });
  });

  it('dentro de la ventana no dice nada: cero no es una observacion', () => {
    // Poner "0 min de desvio" en los 40 puntos de una ronda taparia los dos que
    // si importan.
    expect(desvioDeTurno(new Date('2026-08-08T18:00:00.000Z'), VENTANA)).toBeNull();
    // Los bordes exactos son DENTRO: a las 22:00 en punto todavia es su turno.
    expect(desvioDeTurno(VENTANA.desde, VENTANA)).toBeNull();
    expect(desvioDeTurno(VENTANA.hasta, VENTANA)).toBeNull();
  });

  it('llegar antes tambien es un desvio, y se dice de su lado', () => {
    const desvio = desvioDeTurno(new Date('2026-08-08T13:45:00.000Z'), VENTANA);
    expect(desvio?.borde).toBe('antes_del_inicio');
    expect(desvio?.texto).toBe('15 min antes del inicio del turno');
  });

  it('los desvios largos se leen en horas, no en minutos sueltos', () => {
    // 190 minutos obligaria a dividir mentalmente; quien lee el informe suele
    // tener que decidir algo con ese numero.
    const desvio = desvioDeTurno(new Date('2026-08-09T01:10:00.000Z'), VENTANA);
    expect(desvio?.minutos).toBe(190);
    expect(desvio?.texto).toBe('3 h 10 min después del cierre del turno');
  });

  it('las horas exactas no arrastran un "0 min"', () => {
    const desvio = desvioDeTurno(new Date('2026-08-09T01:00:00.000Z'), VENTANA);
    expect(desvio?.texto).toBe('3 h después del cierre del turno');
  });

  it('medio minuto cuenta como uno: un cero diria que llego a tiempo', () => {
    const desvio = desvioDeTurno(new Date('2026-08-08T22:00:30.000Z'), VENTANA);
    expect(desvio?.minutos).toBe(1);
  });

  it('sin hora o sin ventana no inventa un desvio', () => {
    expect(desvioDeTurno(null, VENTANA)).toBeNull();
    expect(desvioDeTurno(new Date('2026-08-09T05:00:00.000Z'), { desde: null, hasta: null }))
      .toBeNull();
    // Solo con el inicio: se mide contra lo que hay, no se descarta todo.
    expect(
      desvioDeTurno(new Date('2026-08-08T13:00:00.000Z'), { desde: VENTANA.desde, hasta: null })
        ?.borde,
    ).toBe('antes_del_inicio');
  });

  it('el atraso de una TAREA con hora limite se dice igual que el del turno', () => {
    // La tarea "a las 11:00, fotografiar el refrigerador" respondida a las 12:30.
    // Se sube igual — el requisito es explicito— y el informe lo dice.
    expect(redactarAtrasoDeTarea(90)).toBe('1 h 30 min después de la hora pedida');
    expect(redactarAtrasoDeTarea(10)).toBe('10 min después de la hora pedida');
    // Mismo vocabulario que el desvio del turno: "1 h 30 min", no "90".
    expect(redactarAtrasoDeTarea(90)?.startsWith('1 h 30 min')).toBe(true);
  });

  it('una tarea a tiempo (o adelantada) no genera texto', () => {
    // Una hora limite es de un solo lado: adelantarse es trabajo hecho, no una
    // observacion que el supervisor deba revisar.
    expect(redactarAtrasoDeTarea(0)).toBeNull();
    expect(redactarAtrasoDeTarea(null)).toBeNull();
    expect(redactarAtrasoDeTarea(undefined)).toBeNull();
    // Una tarea sin hora limite llega sin `late_minutes`: tampoco dice nada.
    expect(redactarAtrasoDeTarea(-5)).toBeNull();
  });

  it('un turno NOCTURNO que cruza medianoche se mide contra sus instantes reales', () => {
    // La ventana de la ronda llega en timestamptz ya resueltos (22:00 del 8 al
    // 06:00 del 9), asi que cruzar el dia no es un caso especial: seria un caso
    // especial solo si aqui se comparara "hora del dia", que es justo lo que no
    // se hace.
    const nocturno = {
      desde: new Date('2026-08-08T22:00:00.000Z'),
      hasta: new Date('2026-08-09T06:00:00.000Z'),
    };
    expect(desvioDeTurno(new Date('2026-08-09T02:00:00.000Z'), nocturno)).toBeNull();
    expect(desvioDeTurno(new Date('2026-08-09T06:20:00.000Z'), nocturno)?.minutos).toBe(20);
  });
});
