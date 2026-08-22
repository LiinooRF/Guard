/**
 * La cartografía del informe no sirve de nada si el contenedor de la API no
 * recibe la variable que la configura.
 *
 * `MAP_TILE_URL` estaba SOLO en el servicio `web`: el panel mostraba el mapa y
 * el informe salía sin fondo, sin error de por medio y sin que nadie entendiera
 * por qué en pantalla sí y en el PDF no. Es el tipo de fallo que se descubre
 * cuando un cliente pregunta.
 *
 * Se comprueba sobre los compose de verdad y no sobre un doble: lo que importa
 * es lo que se despliega.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSES = ['docker-compose.dokploy.yml', 'docker-compose.production.yml'];

/** Recorta el bloque de un servicio del compose, por indentación. */
function bloqueDelServicio(texto: string, servicio: string): string {
  const inicio = texto.indexOf(`\n  ${servicio}:\n`);
  if (inicio === -1) return '';
  const resto = texto.slice(inicio + 1);
  const siguiente = resto.search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return siguiente === -1 ? resto : resto.slice(0, siguiente);
}

describe('MAP_TILE_URL llega a los dos servicios', () => {
  for (const archivo of COMPOSES) {
    const texto = readFileSync(join(RAIZ, archivo), 'utf8');

    /*
     * Se busca la CLAVE y no el texto suelto: `${MAP_TILE_URL:-}` contiene el
     * nombre igual, asi que un `toContain` pasaba aunque alguien renombrara la
     * variable de entorno. Comprobado borrandola a mano: el test no se enteraba.
     */
    const tieneLaClave = (servicio: string) =>
      bloqueDelServicio(texto, servicio)
        .split('\n')
        .some((linea) => /^\s+MAP_TILE_URL:/.test(linea));

    it(`${archivo}: la API la recibe, o el informe sale sin cartografía`, () => {
      expect(tieneLaClave('api')).toBe(true);
    });

    it(`${archivo}: el panel la sigue recibiendo`, () => {
      expect(tieneLaClave('web')).toBe(true);
    });

    /*
     * Sin default: el proveedor y su llave se deciden por entorno. Un valor
     * escrito en el compose terminaria con una llave de alguien versionada en
     * el repositorio.
     */
    it(`${archivo}: no trae un proveedor escrito a mano`, () => {
      const api = bloqueDelServicio(texto, 'api');
      const linea = api.split('\n').find((l) => l.includes('MAP_TILE_URL')) ?? '';
      expect(linea).toMatch(/\$\{MAP_TILE_URL/);
      expect(linea).not.toMatch(/key=/);
    });
  }
});
