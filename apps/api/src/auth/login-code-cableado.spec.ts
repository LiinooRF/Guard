/**
 * La clave del ingreso por codigo tiene que llegar a los DOS composes.
 *
 * Es el mismo cuidado que ya se le tiene a `MAP_TILE_URL`: una variable puede
 * quedar declarada en un compose y no en el otro, y el fallo no se ve al
 * desplegar —la API arranca igual— sino cuando un guardia intenta entrar con su
 * codigo y no puede. Se comprueba sobre los compose de verdad.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSES = ['docker-compose.dokploy.yml', 'docker-compose.production.yml'];

describe('LOGIN_CODE_PEPPER llega al despliegue', () => {
  for (const archivo of COMPOSES) {
    const texto = readFileSync(join(RAIZ, archivo), 'utf8');

    it(`${archivo} declara la clave`, () => {
      // La CLAVE, no el texto suelto: `${LOGIN_CODE_PEPPER}` contiene el nombre
      // igual y un `toContain` pasaria aunque nadie la reciba.
      const declarada = texto
        .split('\n')
        .some((linea) => /^\s*LOGIN_CODE_PEPPER:\s*\$\{LOGIN_CODE_PEPPER/.test(linea));

      expect(declarada).toBe(true);
    });
  }

  it('el ejemplo de configuración la trae, para que nadie la descubra en producción', () => {
    const ejemplo = readFileSync(join(RAIZ, '.env.example'), 'utf8');

    expect(ejemplo).toMatch(/^LOGIN_CODE_PEPPER=/m);
  });
});
