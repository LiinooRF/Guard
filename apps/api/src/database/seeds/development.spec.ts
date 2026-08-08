import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La demo tiene que ENSEÑAR lo que el producto promete.
 *
 * En staging, el punto insignia —"Acceso principal", un `acceso_critico`— tenia
 * `requires_photo = false`: una anulacion explicita que dice "aqui no se
 * fotografia". Y en `isPhotoRequired()` el override del punto GANA sobre la
 * regla del tenant, asi que la demo mostraba justo lo contrario de lo que hay
 * que enseñar: un acceso critico que no pide foto.
 *
 * La fila venia de una version vieja del seed y nunca se corrigio porque el
 * `ON CONFLICT` solo actualizaba el nombre. El bug no estaba en el codigo:
 * estaba en que el seed no puede arreglar lo que ya sembro mal.
 */
const SEED = readFileSync(join(__dirname, 'development.ts'), 'utf8');

describe('seed de demostracion', () => {
  it('el acceso critico hereda la regla en vez de anularla', () => {
    // NULL = hereda; false = la pisa. Para un `acceso_critico` tiene que ser
    // NULL, o `photoRequiredOnCritical` no se llega a evaluar nunca.
    expect(SEED).toMatch(/'Acceso principal',\s*\d+,\s*'acceso_critico',\s*NULL/);
  });

  it('el ON CONFLICT de los puntos refresca lo que define su comportamiento', () => {
    // Actualizar solo el nombre deja congelado el resto para siempre: un
    // ambiente sembrado por una version vieja se queda con datos que ya no
    // corresponden, y nadie se entera porque el seed "corre bien".
    const insercion = SEED.slice(SEED.indexOf('INSERT INTO checkpoints'));
    const conflicto = insercion.slice(0, insercion.indexOf('`,'));
    for (const columna of ['kind', 'requires_photo', 'instructions']) {
      expect(conflicto).toContain(`${columna} = EXCLUDED.${columna}`);
    }
  });
});
