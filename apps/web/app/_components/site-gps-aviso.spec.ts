import { avisoSinCoordenadas } from './site-gps-aviso';

const punto = (extra: Partial<{ latitude: number | null; longitude: number | null; isActive: boolean }> = {}) => ({
  latitude: -33.45,
  longitude: -70.66,
  isActive: true,
  ...extra,
});

describe('avisoSinCoordenadas', () => {
  it('EL CASO REAL: los dos puntos del demo sin coordenadas → el admin se entera', () => {
    // Dos escaneos desde el mismo escritorio pasaron limpios porque la
    // validación GPS no puede disparar sin coordenadas, y nadie lo decía.
    const aviso = avisoSinCoordenadas([
      punto({ latitude: null, longitude: null }),
      punto({ latitude: null, longitude: null }),
    ]);
    expect(aviso).toContain('2 de 2');
    expect(aviso).toContain('validación GPS');
  });

  it('con todos los puntos ubicados no molesta', () => {
    expect(avisoSinCoordenadas([punto(), punto()])).toBeNull();
  });

  it('un solo punto sin ubicar habla en singular', () => {
    expect(avisoSinCoordenadas([punto(), punto({ latitude: null })])).toContain('1 punto activo');
  });

  it('los puntos dados de baja no cuentan: su validación no valida nada', () => {
    expect(
      avisoSinCoordenadas([punto(), punto({ latitude: null, isActive: false })]),
    ).toBeNull();
  });
});
