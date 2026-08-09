import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { BarrasHorizontales, ColumnasRondas, SerieCumplimiento } from './stats-charts-svg';

const punto = {
  bucket: '2026-08-09',
  patrols: 2,
  completed: 1,
  compliancePct: 80,
};

describe('títulos accesibles de las gráficas (#288)', () => {
  it('renderiza cada title SVG como un único texto, sin advertencias de React', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const html = [
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

    expect(html).toContain('<title>Casa matriz: 80 %</title>');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
