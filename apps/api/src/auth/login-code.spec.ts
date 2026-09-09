/**
 * Ingreso del guardia con codigo de empresa + seis digitos.
 *
 * Decision del equipo el 09-09-2026, con el riesgo sobre la mesa: el codigo
 * identifica Y autentica, asi que los codigos validos son tantos como guardias.
 * Estas pruebas cuidan las piezas que compensan eso.
 */

import { generarCodigo, LARGO_CODIGO, lookupDeCodigo, pepperDeCodigo } from './login-code';

const PEPPER = 'x'.repeat(48);

describe('código de ingreso del guardia', () => {
  describe('el pepper del servidor', () => {
    /*
     * Sin pepper, el lookup se podria calcular desde un volcado de la base:
     * con un millon de combinaciones, quien tenga el dump arma la tabla entera
     * y lee el codigo de cada guardia. Por eso se cae al arrancar en vez de
     * improvisar un valor.
     */
    it('sin la clave, el arranque falla en vez de improvisar una', () => {
      expect(() => pepperDeCodigo({} as NodeJS.ProcessEnv)).toThrow(/LOGIN_CODE_PEPPER/);
      expect(() => pepperDeCodigo({ LOGIN_CODE_PEPPER: '   ' } as NodeJS.ProcessEnv)).toThrow(
        /LOGIN_CODE_PEPPER/,
      );
    });

    it('una clave corta tampoco sirve', () => {
      expect(() => pepperDeCodigo({ LOGIN_CODE_PEPPER: 'corta' } as NodeJS.ProcessEnv)).toThrow(
        /32/,
      );
    });
  });

  describe('el lookup', () => {
    it('es estable: el mismo código en la misma empresa siempre da lo mismo', () => {
      expect(lookupDeCodigo('empresa-1', '483920', PEPPER)).toBe(
        lookupDeCodigo('empresa-1', '483920', PEPPER),
      );
    });

    /*
     * Si el tenant no entrara en el HMAC, el mismo codigo en dos empresas daria
     * el mismo lookup: el indice unico es POR empresa, asi que la colision
     * pasaria el filtro de la base y una busqueda podria traer a un guardia de
     * otra empresa.
     */
    it('el mismo código en otra empresa da un lookup distinto', () => {
      expect(lookupDeCodigo('empresa-1', '483920', PEPPER)).not.toBe(
        lookupDeCodigo('empresa-2', '483920', PEPPER),
      );
    });

    it('no deja rastro del código: no se puede leer del resultado', () => {
      expect(lookupDeCodigo('empresa-1', '483920', PEPPER)).not.toContain('483920');
    });
  });

  describe('el código que se genera', () => {
    it('son seis dígitos, siempre', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(generarCodigo()).toMatch(/^\d{6}$/);
      }
      expect(LARGO_CODIGO).toBe(6);
    });

    /*
     * Sortear entre 100000 y 999999 —el atajo comodo— tira el 10 % del espacio
     * y le regala al atacante saber que ningun codigo empieza en cero. Se
     * comprueba que los que empiezan en cero existen.
     */
    it('no descarta los que empiezan en cero', () => {
      const muestras = Array.from({ length: 4000 }, () => generarCodigo());

      expect(muestras.some((c) => c.startsWith('0'))).toBe(true);
    });

    it('no es predecible: no repite en una tanda corta', () => {
      const muestras = new Set(Array.from({ length: 500 }, () => generarCodigo()));

      expect(muestras.size).toBeGreaterThan(480);
    });
  });
});
