import {
  PRECISION_DUDOSA_M,
  capturaDeEscaneo,
  capturaDeUbicacion,
  redondear,
  textoDePrecision,
} from './puntos-captura';

describe('capturaDeEscaneo', () => {
  it('toma la coordenada que vino con la etiqueta', () => {
    const captura = capturaDeEscaneo({
      uid: '04A2B3C4D5E6F0',
      latitude: -33.44892312,
      longitude: -70.66927891,
      accuracyM: 8,
    });
    expect(captura.uid).toBe('04A2B3C4D5E6F0');
    expect(captura.coordenadas).toEqual([-33.448923, -70.669279]);
  });

  it('avisa cuando la lectura no trajo ubicacion, en vez de dejar el punto sin coordenada callado', () => {
    const captura = capturaDeEscaneo({ uid: 'ABCDEF01' });
    expect(captura.coordenadas).toBeNull();
    expect(captura.aviso).toContain('ABCDEF01');
    expect(captura.aviso).toMatch(/no trajo ubicaci/i);
  });

  it('descarta lecturas fuera de rango o no numericas', () => {
    expect(capturaDeEscaneo({ uid: 'AA11', latitude: 91, longitude: -70.6 }).coordenadas).toBeNull();
    expect(capturaDeEscaneo({ uid: 'AA11', latitude: -33.4, longitude: 181 }).coordenadas).toBeNull();
    expect(capturaDeEscaneo({ uid: 'AA11', latitude: NaN, longitude: -70.6 }).coordenadas).toBeNull();
    expect(
      capturaDeEscaneo({ uid: 'AA11', latitude: -33.4, longitude: undefined }).coordenadas,
    ).toBeNull();
  });

  it('falla fuerte si no hay UID: un punto con etiqueta vacia no se marca nunca', () => {
    expect(() => capturaDeEscaneo({ latitude: -33.4, longitude: -70.6 })).toThrow(/sin UID/i);
    expect(() => capturaDeEscaneo({ uid: '   ' })).toThrow(/sin UID/i);
    expect(() => capturaDeEscaneo(null)).toThrow(/sin UID/i);
  });
});

describe('textoDePrecision', () => {
  it('manda a repetir la medicion cuando el radio deja el punto en otra fachada', () => {
    const texto = textoDePrecision(PRECISION_DUDOSA_M + 15);
    expect(texto).toContain('45 m');
    expect(texto).toMatch(/vuelve a tomarla/i);
  });

  it('no alarma con una lectura buena', () => {
    const texto = textoDePrecision(6);
    expect(texto).toContain('6 m');
    expect(texto).not.toMatch(/ojo|vuelve a tomarla/i);
  });

  it('calla si el telefono no informa precision', () => {
    expect(textoDePrecision(undefined)).toBe('');
    expect(textoDePrecision(NaN)).toBe('');
  });
});

describe('capturaDeUbicacion', () => {
  it('redondea a seis decimales y reporta la precision', () => {
    const captura = capturaDeUbicacion({
      latitude: -33.4489231987,
      longitude: -70.6692789123,
      accuracy: 12,
    });
    expect(captura.coordenadas).toEqual([-33.448923, -70.669279]);
    expect(captura.aviso).toContain('12 m');
  });

  it('no acepta una lectura invalida', () => {
    expect(capturaDeUbicacion({ latitude: NaN, longitude: -70.6 }).coordenadas).toBeNull();
  });
});

describe('redondear', () => {
  it('deja seis decimales, que son ~11 cm', () => {
    expect(redondear(-33.4489231987)).toBe(-33.448923);
    expect(redondear(10)).toBe(10);
  });
});
