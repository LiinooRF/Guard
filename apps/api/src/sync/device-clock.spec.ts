import {
  avisoDeReloj,
  instanteConfiable,
  medirDesfase,
  minutosDeDesfase,
  toleranciaEnMs,
} from './device-clock';

const TOLERANCIA_MIN = 5;

describe('device-clock — medicion del desfase (#73)', () => {
  it('el signo es servidor menos dispositivo: positivo = telefono atrasado', () => {
    const medicion = medirDesfase(
      '2026-08-03T10:00:00.000Z', // el telefono cree que son las 10:00
      '2026-08-03T10:03:00.000Z', // el servidor recibe a las 10:03
      TOLERANCIA_MIN,
    );

    expect(medicion).toEqual({
      offsetMs: 180_000,
      toleranciaMs: 300_000,
      desfasado: false,
    });
    expect(minutosDeDesfase(medicion!)).toBe(3);
  });

  it('un telefono adelantado da offset negativo y tambien se detecta', () => {
    const medicion = medirDesfase(
      '2026-08-03T12:00:00.000Z',
      '2026-08-03T10:00:00.000Z',
      TOLERANCIA_MIN,
    );

    expect(medicion?.offsetMs).toBe(-7_200_000);
    expect(medicion?.desfasado).toBe(true);
    expect(minutosDeDesfase(medicion!)).toBe(-120);
  });

  it('EL BUG QUE CORRIGE: una ronda de 3 horas sin señal no es un reloj desfasado', () => {
    // El telefono encolo el escaneo a las 02:10 y recien a las 05:10 tuvo señal
    // para enviarlo. Su reloj esta perfecto. Medir contra la hora del ESCANEO
    // daria 3 horas de "desfase"; medir contra la hora de ENVIO da cero.
    const medicion = medirDesfase(
      '2026-08-03T05:10:00.000Z', // hora del telefono al enviar
      '2026-08-03T05:10:01.000Z', // el servidor recibe un segundo despues
      TOLERANCIA_MIN,
    );

    expect(medicion?.desfasado).toBe(false);
    expect(avisoDeReloj(medicion)).toBeNull();
  });

  it('la tolerancia es limite inclusivo: justo en el borde no esta desfasado', () => {
    const justo = medirDesfase(
      '2026-08-03T10:00:00.000Z',
      '2026-08-03T10:05:00.000Z',
      TOLERANCIA_MIN,
    );
    const unMsMas = medirDesfase(
      '2026-08-03T10:00:00.000Z',
      '2026-08-03T10:05:00.001Z',
      TOLERANCIA_MIN,
    );

    expect(justo?.desfasado).toBe(false);
    expect(unMsMas?.desfasado).toBe(true);
  });

  it('sin hora del dispositivo no se inventa una medicion', () => {
    expect(medirDesfase(undefined, new Date(), TOLERANCIA_MIN)).toBeNull();
    expect(medirDesfase(null, new Date(), TOLERANCIA_MIN)).toBeNull();
    // Una fecha que no parsea no puede propagarse como NaN por todo el calculo.
    expect(medirDesfase('ayer por la tarde', new Date(), TOLERANCIA_MIN)).toBeNull();
  });

  it('la tolerancia configurada por el admin manda sobre cualquier default', () => {
    expect(toleranciaEnMs(1)).toBe(60_000);
    const conUnMinuto = medirDesfase(
      '2026-08-03T10:00:00.000Z',
      '2026-08-03T10:03:00.000Z',
      1,
    );
    expect(conUnMinuto?.desfasado).toBe(true);
  });

  it('el aviso al guardia dice el sentido y no habla de protocolos', () => {
    const atrasado = medirDesfase(
      '2026-08-03T09:00:00.000Z',
      '2026-08-03T10:00:00.000Z',
      TOLERANCIA_MIN,
    );

    const aviso = avisoDeReloj(atrasado)!;
    expect(aviso).toContain('atrasado');
    expect(aviso).toContain('60 min');
    expect(aviso).toContain('hora automática');
  });
});

describe('device-clock — instante confiable (#73)', () => {
  const SERVIDOR = new Date('2026-08-03T10:00:00.000Z');

  it('sin hora del dispositivo usa la del servidor', () => {
    expect(
      instanteConfiable({ deviceAt: undefined, serverAt: SERVIDOR, medicion: null }),
    ).toEqual({ at: SERVIDOR, fuente: 'servidor', offsetAplicadoMs: 0 });
  });

  it('sin medicion NO corrige: corregir a ciegas seria inventar evidencia', () => {
    const device = '2026-08-03T07:30:00.000Z';
    expect(instanteConfiable({ deviceAt: device, serverAt: SERVIDOR, medicion: null })).toEqual({
      at: new Date(device),
      fuente: 'dispositivo',
      offsetAplicadoMs: 0,
    });
  });

  it('dentro de tolerancia la hora del telefono se usa tal cual', () => {
    const medicion = medirDesfase(
      '2026-08-03T09:59:00.000Z',
      SERVIDOR,
      TOLERANCIA_MIN,
    );
    const device = '2026-08-03T07:30:00.000Z';

    expect(instanteConfiable({ deviceAt: device, serverAt: SERVIDOR, medicion })).toEqual({
      at: new Date(device),
      fuente: 'dispositivo',
      offsetAplicadoMs: 0,
    });
  });

  it('con el reloj atrasado dos horas, corrige el instante del escaneo', () => {
    // El telefono va 2 horas atrasado. El escaneo que el marca a las 05:30
    // ocurrio en realidad a las 07:30.
    const medicion = medirDesfase(
      '2026-08-03T08:00:00.000Z',
      SERVIDOR,
      TOLERANCIA_MIN,
    );

    expect(
      instanteConfiable({
        deviceAt: '2026-08-03T05:30:00.000Z',
        serverAt: SERVIDOR,
        medicion,
      }),
    ).toEqual({
      at: new Date('2026-08-03T07:30:00.000Z'),
      fuente: 'corregido',
      offsetAplicadoMs: 7_200_000,
    });
  });

  it('una correccion que cae en el futuro se topa en la hora del servidor', () => {
    // El guardia cambio la hora del telefono ENTRE encolar y enviar: la
    // correccion medida al enviar no aplica al instante encolado y proyectaria
    // el escaneo despues de su propia llegada.
    const medicion = medirDesfase(
      '2026-08-03T08:00:00.000Z',
      SERVIDOR,
      TOLERANCIA_MIN,
    );

    expect(
      instanteConfiable({
        deviceAt: '2026-08-03T09:30:00.000Z',
        serverAt: SERVIDOR,
        medicion,
      }),
    ).toEqual({ at: SERVIDOR, fuente: 'servidor', offsetAplicadoMs: 0 });
  });
});
