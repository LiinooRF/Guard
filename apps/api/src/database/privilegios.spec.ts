import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que cada migracion DECLARA que la tabla puede hacer, contra lo que el rol
 * de la aplicacion puede de verdad.
 *
 * `docker/postgres/init/01-app-role.sh:40-41` reparte por default privileges
 * `SELECT, INSERT, UPDATE, DELETE` sobre toda tabla nueva del esquema. Eso evita
 * tener que acordarse de un GRANT en cada migracion — pero tiene una
 * consecuencia que se leyo al reves durante meses: **un `GRANT SELECT, INSERT`
 * no acota nada**. Solo repite dos de los cuatro permisos que el rol ya tiene.
 * Lo unico que quita algo es un REVOKE explicito.
 *
 * Cinco tablas habian escrito su intencion en el GRANT y se habian quedado sin
 * el REVOKE, asi que la base concedia mas de lo que su propia migracion decia.
 * Dos de ellas —`platform_rules` y `auth_action_tokens`— se escriben solo desde
 * funciones `SECURITY DEFINER` que validan quien eres antes de tocar la fila: el
 * permiso directo hacia decorativa esa validacion.
 *
 * Por eso este test lee el GRANT como declaracion de intencion y falla cuando el
 * permiso efectivo la supera. Si agregas una tabla y quieres que el rol pueda
 * menos que los cuatro por default, **escribe el REVOKE**.
 */
const CARPETA = join(__dirname, 'migrations');
const TODOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Permiso = (typeof TODOS)[number];

/**
 * Diferencias revisadas y aceptadas, con el motivo. Cada una es una decision
 * tomada a mano, no un olvido: por eso van con nombre y explicacion en vez de
 * apagar el test.
 */
const ACEPTADAS = new Map<string, string>([
  [
    'platform_audit_log:SELECT',
    'Su migracion concede INSERT y revoca UPDATE/DELETE; el SELECT llega por ' +
      'default privileges. Ninguna consulta de la aplicacion lo lee hoy, pero ' +
      'leer un registro append-only no lo pone en riesgo y el panel de ' +
      'plataforma va a necesitarlo.',
  ],
]);

interface Privilegios {
  declarado: Set<Permiso>;
  revocado: Set<Permiso>;
}

function permisosDe(texto: string): Set<Permiso> {
  // `UPDATE (columna)` es permiso por COLUMNA: no concede la tabla entera y por
  // eso no cuenta como tal. Justamente ese matiz era el que se perdia.
  return new Set(TODOS.filter((permiso) => new RegExp(`\\b${permiso}\\b(?!\\s*\\()`).test(texto)));
}

function leerPrivilegios(): Map<string, Privilegios> {
  const tablas = new Map<string, Privilegios>();
  const archivos = readdirSync(CARPETA)
    .filter((archivo) => archivo.endsWith('.ts') && !archivo.endsWith('.spec.ts'))
    .sort();

  for (const archivo of archivos) {
    const texto = readFileSync(join(CARPETA, archivo), 'utf8');

    for (const [, tabla] of texto.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) {
      if (tabla && !tablas.has(tabla)) {
        tablas.set(tabla, { declarado: new Set(), revocado: new Set() });
      }
    }

    // El orden manda: un GRANT posterior a un REVOKE lo deshace.
    for (const accion of texto.matchAll(
      /(GRANT|REVOKE)\s+([A-Z][A-Z, ()a-z_]*?)\s+ON\s+([a-z_]+)\s+(?:TO|FROM)/g,
    )) {
      const [, verbo, lista, tabla] = accion;
      const privilegios = tablas.get(tabla ?? '');
      if (!privilegios) continue;
      for (const permiso of permisosDe(lista ?? '')) {
        if (verbo === 'GRANT') {
          privilegios.declarado.add(permiso);
          privilegios.revocado.delete(permiso);
        } else {
          privilegios.revocado.add(permiso);
        }
      }
    }
  }
  return tablas;
}

describe('privilegios del rol de la aplicacion', () => {
  const tablas = leerPrivilegios();

  it('hay tablas que analizar', () => {
    expect(tablas.size).toBeGreaterThan(20);
  });

  it('ninguna tabla concede mas de lo que su migracion declara', () => {
    const deMas: string[] = [];

    for (const [tabla, { declarado, revocado }] of tablas) {
      // Sin GRANT propio no hay intencion escrita contra la cual comparar: eso
      // lo cubre el test siguiente.
      if (declarado.size === 0) continue;
      for (const permiso of TODOS) {
        const efectivo = !revocado.has(permiso);
        const senal = `${tabla}:${permiso}`;
        if (efectivo && !declarado.has(permiso) && !ACEPTADAS.has(senal)) {
          deMas.push(senal);
        }
      }
    }

    // Si esto falla: agrega el REVOKE en una migracion nueva. Conceder de menos
    // rompe una peticion y se ve; conceder de mas no se ve nunca.
    expect(deMas.sort()).toEqual([]);
  });

  it('las tablas append-only revocan UPDATE y DELETE, no solo omiten concederlos', () => {
    // Estas cuatro son las que sostienen el valor probatorio del producto: el
    // libro de novedades y la auditoria terminan en juicios laborales, y un
    // registro editable no sirve como prueba. Omitir el GRANT no basta.
    const INMUTABLES = ['field_events', 'scan_photos', 'event_photos', 'audit_log'];
    const flojas = INMUTABLES.filter((tabla) => {
      const privilegios = tablas.get(tabla);
      return !privilegios?.revocado.has('UPDATE') || !privilegios.revocado.has('DELETE');
    });
    expect(flojas).toEqual([]);
  });
});
