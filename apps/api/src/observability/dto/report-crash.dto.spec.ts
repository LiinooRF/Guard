import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ReportCrashDto } from './report-crash.dto';

/**
 * El ValidationPipe global corre con `{ whitelist, forbidNonWhitelisted,
 * transform }` (main.ts), asi que se reproduce con `plainToInstance` +
 * `validateSync`.
 *
 * Lo que se prueba aca es la frontera entre 400 y 500: un valor en blanco que
 * el DTO deje pasar termina violando un CHECK de la tabla, y eso el cliente lo
 * ve como "el servidor se cayo" en vez de "mandaste algo invalido".
 */
function validar(cuerpo: Record<string, unknown>) {
  const dto = plainToInstance(ReportCrashDto, {
    errorName: 'NfcBridgeError',
    errorMessage: 'no se pudo leer la etiqueta',
    appVersion: '1.4.2',
    deviceModel: 'Redmi 9A',
    androidVersion: '10',
    ...cuerpo,
  });

  return { dto, errores: validateSync(dto as object).map((error) => error.property) };
}

describe('ReportCrashDto', () => {
  it('acepta el cuerpo del contrato documentado', () => {
    expect(validar({}).errores).toEqual([]);
  });

  it('recorta el modelo y la version de Android antes de validar', () => {
    const { dto, errores } = validar({ deviceModel: '  Redmi 9A  ', androidVersion: ' 13 ' });

    expect(errores).toEqual([]);
    expect(dto.deviceModel).toBe('Redmi 9A');
    expect(dto.androidVersion).toBe('13');
  });

  it.each([['deviceModel'], ['androidVersion']])(
    'un %s de puros espacios es 400 y no un 500 contra el CHECK de la tabla',
    (campo) => {
      // El CHECK es `length(trim(...)) BETWEEN 1 AND N`: sin el recorte previo,
      // '   ' pasa @Length(1, N) y revienta recien en Postgres.
      expect(validar({ [campo]: '   ' }).errores).toContain(campo);
    },
  );

  it('una version de app en blanco tambien es 400, por el @Matches', () => {
    expect(validar({ appVersion: '   ' }).errores).toContain('appVersion');
  });
});
