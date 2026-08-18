import { patrolRulesSchema } from '@sentrycore/shared';

import { rondaVencida } from './patrol-expiry';

// Defaults del producto: maxPatrolDurationMin 480 (8 h), lateScanGraceMin 120.
const reglas = patrolRulesSchema.parse({});

const MINUTO = 60_000;

describe('rondaVencida', () => {
  const inicio = new Date('2026-08-06T22:00:00.000Z');
  const finVentana = new Date('2026-08-07T06:00:00.000Z');

  it('una ronda en curso vence pasado maxPatrolDurationMin desde que se inicio', () => {
    const ronda = { status: 'en_curso', startedAt: inicio, scheduledEndAt: finVentana };
    // El caso real que motivo esto: 48 horas en curso.
    expect(rondaVencida(ronda, reglas, new Date('2026-08-08T22:00:00.000Z'))).toBe(true);
    // Un minuto despues del limite: vencida.
    expect(rondaVencida(ronda, reglas,
      new Date(inicio.getTime() + 481 * MINUTO))).toBe(true);
  });

  it('en el limite exacto todavia NO vence: la ficha dice "tras los cuales"', () => {
    const ronda = { status: 'en_curso', startedAt: inicio, scheduledEndAt: finVentana };
    expect(rondaVencida(ronda, reglas,
      new Date(inicio.getTime() + 480 * MINUTO))).toBe(false);
  });

  it('una ronda en curso dentro de su plazo no vence', () => {
    const ronda = { status: 'en_curso', startedAt: inicio, scheduledEndAt: finVentana };
    expect(rondaVencida(ronda, reglas, new Date(inicio.getTime() + 30 * MINUTO))).toBe(false);
  });

  it('una pendiente vence cuando la ventana paso y se agoto la gracia', () => {
    const ronda = { status: 'pendiente', startedAt: null, scheduledEndAt: finVentana };
    // Dentro de la gracia (120 min): empezar tarde es un atraso, no un crimen.
    expect(rondaVencida(ronda, reglas,
      new Date(finVentana.getTime() + 60 * MINUTO))).toBe(false);
    // Agotada la gracia: vencida.
    expect(rondaVencida(ronda, reglas,
      new Date(finVentana.getTime() + 121 * MINUTO))).toBe(true);
  });

  it('una en_curso sin started_at no vence por duracion: no hay desde cuando contar', () => {
    // Estado defensivo: no deberia existir, pero si existe, vencerla seria
    // decidir con un dato que no esta.
    const ronda = { status: 'en_curso', startedAt: null, scheduledEndAt: finVentana };
    expect(rondaVencida(ronda, reglas, new Date('2026-09-01T00:00:00.000Z'))).toBe(false);
  });

  it('una ronda ya cerrada nunca "vence": el estado final no se pisa', () => {
    for (const status of ['completada', 'incompleta', 'vencida']) {
      expect(rondaVencida(
        { status, startedAt: inicio, scheduledEndAt: finVentana },
        reglas,
        new Date('2026-09-01T00:00:00.000Z'),
      )).toBe(false);
    }
  });
});
