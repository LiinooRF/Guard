import {
  esRondaCerrada,
  evaluarEscaneoAtrasado,
  sugerenciaPara,
  type RondaCerrada,
} from './late-scan.policy';

const GRACIA_MIN = 120;

/** Ronda vencida por tiempo: la cerro el reloj, no el guardia. */
const VENCIDA: RondaCerrada = {
  status: 'vencida',
  closedAt: null,
  scheduledEndAt: new Date('2026-08-03T06:00:00.000Z'),
};

describe('late-scan.policy — que gana cuando la ronda ya estaba cerrada (#73)', () => {
  it('reconoce los tres estados de ronda cerrada y solo esos', () => {
    expect(esRondaCerrada('completada')).toBe(true);
    expect(esRondaCerrada('incompleta')).toBe(true);
    expect(esRondaCerrada('vencida')).toBe(true);
    expect(esRondaCerrada('pendiente')).toBe(false);
    expect(esRondaCerrada('en_curso')).toBe(false);
  });

  it('la marca hecha ANTES del cierre es entrega tardia, no marca tardia', () => {
    // El caso del subterraneo: el guardia marco a las 05:40, la ronda vencio a
    // las 06:00 y el telefono recien tuvo señal a las 09:00.
    const veredicto = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T05:40:00.000Z'),
      GRACIA_MIN,
    );

    expect(veredicto.clasificacion).toBe('dentro_de_la_ventana');
    expect(veredicto.minutosDeAtraso).toBe(0);
    // Lo que llego tarde fue la red, no el guardia.
    expect(veredicto.sugerencia).toBe('justificado');
    expect(veredicto.mensaje).toContain('llegó tarde por falta de señal');
    expect(veredicto.mensaje).toContain('no se perdió');
  });

  it('manda el cierre efectivo, no el fin programado', () => {
    // Ronda con ventana hasta las 23:00 que el guardia cerro a las 22:30. Una
    // marca de las 22:45 cae dentro de la ventana pero DESPUES del cierre.
    const completada: RondaCerrada = {
      status: 'completada',
      closedAt: new Date('2026-08-03T22:30:00.000Z'),
      scheduledEndAt: new Date('2026-08-03T23:00:00.000Z'),
    };

    const veredicto = evaluarEscaneoAtrasado(
      completada,
      new Date('2026-08-03T22:45:00.000Z'),
      GRACIA_MIN,
    );

    expect(veredicto.clasificacion).toBe('dentro_de_gracia');
    expect(veredicto.minutosDeAtraso).toBe(15);
    expect(veredicto.mensaje).toContain('cerrada en el punto de cierre');
  });

  it('medio minuto de atraso se informa como 1 min, nunca como 0', () => {
    const veredicto = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T06:00:30.000Z'),
      GRACIA_MIN,
    );

    expect(veredicto.clasificacion).toBe('dentro_de_gracia');
    // Un cero le diria al supervisor que llego a tiempo, y no llego a tiempo.
    expect(veredicto.minutosDeAtraso).toBe(1);
  });

  it('el plazo de gracia es limite inclusivo', () => {
    const justo = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T08:00:00.000Z'), // exactamente 120 min despues
      GRACIA_MIN,
    );
    const unMsMas = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T08:00:00.001Z'),
      GRACIA_MIN,
    );

    expect(justo.clasificacion).toBe('dentro_de_gracia');
    expect(unMsMas.clasificacion).toBe('fuera_de_plazo');
  });

  it('la marca muy posterior al cierre queda fuera de plazo y va a revision', () => {
    const veredicto = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T14:00:00.000Z'), // 8 horas despues
      GRACIA_MIN,
    );

    expect(veredicto.clasificacion).toBe('fuera_de_plazo');
    expect(veredicto.minutosDeAtraso).toBe(480);
    expect(veredicto.sugerencia).toBe('revisar');
    expect(veredicto.mensaje).toContain('fuera del plazo de 120 min');
  });

  it('el plazo sale de la regla del tenant, no de un numero de este archivo', () => {
    const instante = new Date('2026-08-03T06:45:00.000Z'); // 45 min despues

    expect(evaluarEscaneoAtrasado(VENCIDA, instante, 60).clasificacion).toBe('dentro_de_gracia');
    expect(evaluarEscaneoAtrasado(VENCIDA, instante, 30).clasificacion).toBe('fuera_de_plazo');
    // Gracia cero: cualquier marca posterior al cierre queda fuera de plazo.
    expect(evaluarEscaneoAtrasado(VENCIDA, instante, 0).clasificacion).toBe('fuera_de_plazo');
  });

  it('el cumplimiento ya informado no cambia: eso se dice en el mensaje', () => {
    const veredicto = evaluarEscaneoAtrasado(
      VENCIDA,
      new Date('2026-08-03T05:00:00.000Z'),
      GRACIA_MIN,
    );

    expect(veredicto.mensaje).toContain('el cumplimiento ya informado de esa ronda no cambia');
  });

  it('la sugerencia se calcula en un solo lugar para la bandeja y para el veredicto', () => {
    expect(sugerenciaPara('dentro_de_la_ventana')).toBe('justificado');
    expect(sugerenciaPara('dentro_de_gracia')).toBe('revisar');
    expect(sugerenciaPara('fuera_de_plazo')).toBe('revisar');
  });
});
