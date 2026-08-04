import { BadRequestException } from '@nestjs/common';

import {
  DIAS_POR_DEFECTO,
  MAX_DIAS_ESCANEOS,
  MAX_DIAS_RANKING,
  MAX_DIAS_SERIE,
  resolverRango,
} from './stats-range';

describe('resolverRango', () => {
  it('incluye ambos extremos del rango', () => {
    expect(resolverRango('2026-03-01', '2026-03-31', MAX_DIAS_SERIE)).toEqual({
      desde: '2026-03-01',
      hasta: '2026-03-31',
      dias: 31,
    });
  });

  it('un solo dia es un rango valido de un dia', () => {
    expect(resolverRango('2026-03-01', '2026-03-01', MAX_DIAS_SERIE).dias).toBe(1);
  });

  it('sin parametros abre en el ultimo mes', () => {
    const rango = resolverRango(undefined, undefined, MAX_DIAS_SERIE);
    expect(rango.dias).toBe(DIAS_POR_DEFECTO);
    expect(rango.desde < rango.hasta).toBe(true);
  });

  it('sin `from` cuenta el mes hacia atras desde `to`', () => {
    expect(resolverRango(undefined, '2026-03-31', MAX_DIAS_SERIE)).toEqual({
      desde: '2026-03-02',
      hasta: '2026-03-31',
      dias: 30,
    });
  });

  /**
   * El cambio de horario de Chile cae dentro de este rango. La aritmetica del
   * rango es de CALENDARIO —no convierte zonas— y por eso el conteo de dias no
   * se corre: la zona del recinto entra despues, en el SQL.
   */
  it('no pierde ni gana un dia en el cambio de horario', () => {
    expect(resolverRango('2026-04-01', '2026-04-30', MAX_DIAS_SERIE).dias).toBe(30);
    expect(resolverRango('2026-09-01', '2026-09-30', MAX_DIAS_SERIE).dias).toBe(30);
  });

  it('cuenta bien el año bisiesto', () => {
    expect(resolverRango('2028-02-01', '2028-02-29', MAX_DIAS_SERIE).dias).toBe(29);
  });

  it('rechaza `from` posterior a `to`', () => {
    expect(() => resolverRango('2026-03-31', '2026-03-01', MAX_DIAS_SERIE)).toThrow(
      BadRequestException,
    );
  });

  it('rechaza una fecha que no existe en el calendario', () => {
    expect(() => resolverRango('2026-02-30', '2026-03-01', MAX_DIAS_SERIE)).toThrow(
      BadRequestException,
    );
  });

  it('rechaza un formato que no es YYYY-MM-DD', () => {
    expect(() => resolverRango('01-03-2026', undefined, MAX_DIAS_SERIE)).toThrow(
      BadRequestException,
    );
    expect(() => resolverRango('2026-03-01T00:00:00Z', undefined, MAX_DIAS_SERIE)).toThrow(
      BadRequestException,
    );
  });

  /** Una grafica "desde el inicio de los tiempos" no se sirve: se rechaza. */
  it('corta el rango en el tope de cada grafica', () => {
    expect(resolverRango('2024-01-01', '2025-12-31', MAX_DIAS_SERIE).dias).toBe(731);
    expect(() => resolverRango('2020-01-01', '2026-01-01', MAX_DIAS_SERIE)).toThrow(
      /maximo de esta grafica es 731/,
    );
    expect(() => resolverRango('2024-01-01', '2026-01-01', MAX_DIAS_RANKING)).toThrow(
      /maximo de esta grafica es 366/,
    );
    // El tope corto es el de la grafica que baja a `scans`.
    expect(() => resolverRango('2026-01-01', '2026-06-01', MAX_DIAS_ESCANEOS)).toThrow(
      /maximo de esta grafica es 92/,
    );
  });

  it('los topes van de mas corto a mas largo segun la tabla que tocan', () => {
    expect(MAX_DIAS_ESCANEOS).toBeLessThan(MAX_DIAS_RANKING);
    expect(MAX_DIAS_RANKING).toBeLessThan(MAX_DIAS_SERIE);
  });
});
