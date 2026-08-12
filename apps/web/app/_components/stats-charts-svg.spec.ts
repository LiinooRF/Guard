import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { BarrasHorizontales, ColumnasRondas, SerieCumplimiento } from './stats-charts-svg';

const punto = {
  bucket: '2026-08-09',
  patrols: 2,
  completed: 1,
  compliancePct: 80,
};

/**
 * #288 — hidratación de las gráficas.
 *
 * El detalle por dato vivía en un `<title>` SVG hijo de cada `<g>`. React 19
 * HOISTEA los `<title>` al `<head>` como metadata del documento —aun dentro de
 * un `<svg>`—, así que en el cliente el título se movía y el subárbol dejaba de
 * coincidir con el HTML del servidor: "Hydration failed", reproducido en
 * Firefox y apuntando justo al `<title>` de la sucursal.
 *
 * La estrategia nueva: el nombre accesible por dato va en `aria-label` del
 * `<g>`. Un lector de pantalla lo lee igual, el valor visible ya está en el
 * `<text>` y en la tabla, y no hay ningún elemento que React pueda reubicar.
 * Esta prueba fija esa estrategia: si alguien vuelve a meter un `<title>` en el
 * SVG, falla.
 */
describe('títulos accesibles de las gráficas (#288)', () => {
  function markup(): string {
    return [
      renderToStaticMarkup(
        createElement(BarrasHorizontales, {
          ariaLabel: 'Cumplimiento',
          escala: 100,
          items: [{ clave: 'casa', titulo: 'Casa matriz', valor: 80, etiquetaValor: '80 %' }],
        }),
      ),
      renderToStaticMarkup(
        createElement(SerieCumplimiento, {
          ariaLabel: 'Evolución', granularidad: 'dia', puntos: [punto], umbral: 70,
        }),
      ),
      renderToStaticMarkup(
        createElement(ColumnasRondas, {
          ariaLabel: 'Rondas', granularidad: 'dia', puntos: [punto],
        }),
      ),
    ].join('');
  }

  it('el detalle por dato va en aria-label, NUNCA en un <title> que React hoistea', () => {
    const html = markup();
    // El nombre accesible del dato, ahora en el atributo del <g>.
    expect(html).toContain('aria-label="Casa matriz: 80 %"');
    // Y ni un solo <title>: es el elemento que se reubicaba y rompía la hidratación.
    expect(html).not.toContain('<title>');
  });

  it('renderiza sin que React emita advertencias', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    markup();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
