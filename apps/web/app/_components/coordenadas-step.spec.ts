/**
 * Los campos de coordenadas aceptan CUALQUIER cantidad de decimales.
 *
 * Estaban con `step="0.000001"`, o sea seis decimales exactos. Un `step` fijo
 * no es cosmético: el navegador RECHAZA el valor que no sea múltiplo del paso y
 * el formulario no se envía. Quien copia una coordenada de Google Maps la pega
 * con siete u ocho decimales (-33.44889912) y el campo la da por inválida sin
 * decir por qué — que es justo lo que se reportó desde terreno.
 *
 * `step="any"` acepta lo que venga. La precisión real la fija la base, que
 * guarda `numeric(9,6)`: seis decimales son 11 cm, de sobra para un GPS de
 * teléfono que ronda los 3 metros de error.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANTALLAS = ['site-management.tsx', 'puntos-supervisor.tsx'];

describe('campos de latitud y longitud', () => {
  for (const archivo of PANTALLAS) {
    const fuente = readFileSync(join(__dirname, archivo), 'utf8');

    it(`${archivo}: ningún campo de coordenadas usa un step fijo`, () => {
      const conStepFijo = fuente.match(/(latitude|longitude|min=\{-(90|180)\})[^>]*step="0\.0+1"/g) ?? [];
      expect(conStepFijo).toEqual([]);
    });

    it(`${archivo}: los campos de coordenadas usan step="any"`, () => {
      const campos = fuente.match(/name="(latitude|longitude)"[^>]*step="any"/g) ?? [];
      const rangos = fuente.match(/step="any" min=\{-(90|180)\}/g) ?? [];
      expect(campos.length + rangos.length).toBeGreaterThanOrEqual(2);
    });
  }

  it('se conserva el rango válido: la latitud no puede pasar de ±90', () => {
    const fuente = readFileSync(join(__dirname, 'puntos-supervisor.tsx'), 'utf8');
    expect(fuente).toContain('min={-90} max={90}');
    expect(fuente).toContain('min={-180} max={180}');
  });
});
