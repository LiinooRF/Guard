/**
 * Ronda voluntaria en la pantalla del guardia (#133).
 *
 * El backend estaba completo desde hacia meses —endpoint, `is_voluntary`,
 * exclusion de los promedios de cumplimiento— pero la app no la mencionaba en
 * ningun lado: la funcion existia y el guardia no tenia como usarla. Pedido de
 * terreno (Bruno, 09-09-2026): que pueda salir a rondar cuando quiera, para que
 * el horario no sea predecible.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const AQUI = __dirname;
const pantalla = readFileSync(join(AQUI, 'guard-home.tsx'), 'utf8');
const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');

describe('ronda voluntaria en la app del guardia', () => {
  it('llama al endpoint que ya existia', () => {
    expect(pantalla).toContain('/voluntary-patrol');
    expect(pantalla).toMatch(/method: 'POST'/);
  });

  /*
   * Con una ronda abierta el servidor rechaza la voluntaria (una a la vez), asi
   * que ofrecerla ahi seria un boton que falla. Se muestra unicamente en la
   * rama de "no tienes ronda asignada".
   */
  it('solo se ofrece cuando el guardia no tiene ronda', () => {
    const ramaSinRonda = pantalla.slice(
      pantalla.indexOf('No tienes una ronda asignada'),
      pantalla.indexOf('const { patrol, shift } = data;'),
    );

    expect(ramaSinRonda).toContain('ronda-voluntaria');
    expect(ramaSinRonda).toContain('Iniciar ronda voluntaria');
  });

  it('no deja iniciar sin elegir ruta cuando hay varias', () => {
    expect(pantalla).toMatch(/rutasVoluntarias\.length > 1 && rutaElegida === ''/);
  });

  it('con una sola ruta no obliga a elegirla de una lista', () => {
    expect(pantalla).toMatch(/rutasVoluntarias\.length === 1 \? rutasVoluntarias\[0\]!\.id/);
  });

  /*
   * Se usa de pie, en la calle y a veces con guantes: los controles no pueden
   * quedar por debajo del minimo tactil comodo.
   */
  it('el botón y el selector son cómodos para un dedo', () => {
    const boton = css.match(/\.ronda-voluntaria \.primary-button \{[^}]*\}/);
    const select = css.match(/\.ronda-voluntaria-ruta select \{[^}]*\}/);

    for (const regla of [boton, select]) {
      expect(regla).not.toBeNull();
      const alto = Number(regla![0].match(/min-height: ([\d.]+)rem/)![1]);
      expect(alto * 16).toBeGreaterThanOrEqual(44);
    }
  });

  it('le explica al guardia para qué sirve, sin jerga', () => {
    expect(pantalla).toContain('sin esperar a que te la asignen');
    expect(pantalla).not.toMatch(/is_voluntary|voluntaryRoutes<\/|endpoint/i);
  });
});
