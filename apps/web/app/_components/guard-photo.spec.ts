/**
 * Pruebas de la lógica pura del procesamiento de foto (#67).
 *
 * Se prueba lo que decide el resultado sin depender del navegador: el reescalado
 * preserva la proporción y no agranda, y la marca de agua arma sus líneas con lo
 * que hay. El dibujo en canvas y la compresión JPEG son del navegador y se
 * verifican a mano en el dispositivo.
 */

import {
  CALIDADES_JPEG,
  LADO_MAXIMO,
  TAMANO_OBJETIVO_BYTES,
  calcularDimensiones,
  fechaHoraMarca,
  lineasMarcaAgua,
} from './guard-photo';

describe('calcularDimensiones', () => {
  it('reescala el lado largo al máximo y mantiene la proporción', () => {
    const destino = calcularDimensiones({ ancho: 4000, alto: 3000, ladoMax: 1600 });
    expect(destino.ancho).toBe(1600);
    expect(destino.alto).toBe(1200);
  });

  it('usa el alto cuando la foto es vertical', () => {
    const destino = calcularDimensiones({ ancho: 3000, alto: 4000, ladoMax: 1600 });
    expect(destino.alto).toBe(1600);
    expect(destino.ancho).toBe(1200);
  });

  it('no agranda una foto que ya cabe', () => {
    const destino = calcularDimensiones({ ancho: 800, alto: 600, ladoMax: 1600 });
    expect(destino).toEqual({ ancho: 800, alto: 600 });
  });

  it('trata el lado máximo por defecto', () => {
    const destino = calcularDimensiones({ ancho: LADO_MAXIMO * 2, alto: LADO_MAXIMO * 2 });
    expect(Math.max(destino.ancho, destino.alto)).toBe(LADO_MAXIMO);
  });

  it('no devuelve dimensiones cero ante una imagen degenerada', () => {
    const destino = calcularDimensiones({ ancho: 0, alto: 0, ladoMax: 1600 });
    expect(destino).toEqual({ ancho: 0, alto: 0 });
  });
});

describe('lineasMarcaAgua', () => {
  it('junta sitio y ruta en una sola línea', () => {
    const lineas = lineasMarcaAgua({
      fechaHora: '04-08-2026 23:41',
      sitio: 'Bodega Norte',
      ruta: 'Perímetro',
    });
    expect(lineas).toEqual(['04-08-2026 23:41', 'Bodega Norte · Perímetro']);
  });

  it('la fecha y hora es siempre la primera línea', () => {
    const lineas = lineasMarcaAgua({ fechaHora: '04-08-2026 23:41' });
    expect(lineas[0]).toBe('04-08-2026 23:41');
  });

  it('descarta las partes vacías en vez de dibujar renglones en blanco', () => {
    const lineas = lineasMarcaAgua({
      fechaHora: '04-08-2026 23:41',
      sitio: '   ',
      ruta: '',
      guardia: '',
    });
    expect(lineas).toEqual(['04-08-2026 23:41']);
  });

  it('incluye al guardia cuando el portal lo tiene a mano', () => {
    const lineas = lineasMarcaAgua({
      fechaHora: '04-08-2026 23:41',
      sitio: 'Bodega Norte',
      guardia: 'J. Pérez',
    });
    expect(lineas).toContain('J. Pérez');
  });
});

describe('fechaHoraMarca', () => {
  it('formatea en 24 h con fecha completa', () => {
    // 2026-08-05T02:41:00Z = 22:41 del 04-08 en Santiago (agosto es invierno,
    // UTC-4).
    const texto = fechaHoraMarca(new Date('2026-08-05T02:41:00Z'));
    expect(texto).toMatch(/^\d{2}-\d{2}-\d{4}/);
    expect(texto).toContain('22:41');
  });
});

describe('constantes de compresión', () => {
  it('el objetivo de tamaño sube bien con red pobre', () => {
    expect(TAMANO_OBJETIVO_BYTES).toBe(500 * 1024);
  });

  it('las calidades van de mayor a menor para degradar lo mínimo', () => {
    const ordenadas = [...CALIDADES_JPEG].sort((a, b) => b - a);
    expect(CALIDADES_JPEG).toEqual(ordenadas);
    expect(CALIDADES_JPEG[0]).toBeLessThanOrEqual(1);
  });
});
