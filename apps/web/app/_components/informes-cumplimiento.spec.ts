/**
 * El supervisor tenia que DESCARGAR el PDF de cada ronda solo para saber con
 * que porcentaje habia cerrado. Pedido de terreno (Bruno, 09-09-2026): verlo
 * de un vistazo en la misma lista desde donde se bajan los informes.
 *
 * El dato no habia que calcularlo: `GET /supervisor/sites/:id/patrols` ya
 * devolvia `compliancePct`. Se perdia en el panel, que armaba la lista sin ese
 * campo. Estos tests cuidan las tres piezas de esa cadena.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const AQUI = __dirname;
const panel = readFileSync(join(AQUI, 'informes-panel.tsx'), 'utf8');
const supervisor = readFileSync(join(AQUI, 'supervisor-informes.tsx'), 'utf8');
const datos = readFileSync(join(AQUI, 'supervisor-datos.ts'), 'utf8');
const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');

describe('cumplimiento a la vista en la lista de informes', () => {
  it('el dato viaja desde la API hasta la lista sin perderse', () => {
    // 1. lo que trae el servidor
    expect(datos).toMatch(/compliancePct: number \| null/);
    // 2. el panel lo acepta
    expect(panel).toMatch(/compliancePct\?: number \| null/);
    // 3. y quien arma la lista lo pasa, que es donde se perdia
    expect(supervisor).toContain('compliancePct: ronda.compliancePct');
  });

  it('lo muestra junto a la fecha y el estado de la ronda', () => {
    expect(panel).toContain('% cumplido');
  });

  /*
   * Una ronda en curso no tiene porcentaje: se comprueba que el render
   * distinga el numero de la ausencia de numero en vez de imprimir "null%" o
   * un 0 que se leeria como "no cumplio nada".
   */
  it('una ronda sin cerrar no inventa un porcentaje', () => {
    expect(panel).toContain("typeof ronda.compliancePct === 'number'");
  });

  /*
   * El umbral que decide si un porcentaje es bueno lo configura cada empresa
   * (`complianceThreshold`, 70 % por defecto) y este componente no lo recibe.
   * Pintar de rojo un 75 % que para ese cliente esta bien seria inventarle un
   * juicio al supervisor, asi que se distingue por peso tipografico.
   */
  it('no se pinta con semáforo: el umbral es de cada empresa', () => {
    const regla = css.match(/\.informes-cumplimiento \{[^}]*\}/);

    expect(regla).not.toBeNull();
    expect(regla![0]).toContain('font-weight');
    expect(regla![0]).not.toMatch(/#[0-9a-f]{3,6}|red|crimson|var\(--(danger|error|success|warn)/i);
  });
});
