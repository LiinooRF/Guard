import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  COLUMNA_TENANT,
  TABLAS_SIN_TENANT_ID,
  columnaDeAislamiento,
  consultaDeVisibilidad,
  expresionDeEscritura,
  expresionDeVisibilidad,
  filaSintetica,
  type PoliticaDeTabla,
} from './aislamiento-tenant';

/**
 * La mitad barata del test de aislamiento (#218): la que corre siempre, sin
 * base de datos.
 *
 * Solo comprueba UNA cosa del esquema —que ninguna tabla nueva se quede sin
 * `tenant_id` sin decir por que— y a cambio corre en cada `npm test`, tambien
 * en la maquina del que no levanto PostgreSQL. Esa es la falla que se repite:
 * la tabla nace, la migracion se revisa por lo que hace, y la pregunta "de
 * quien son estas filas" no se la hace nadie.
 *
 * ADREDE NO comprueba aca ni el ENABLE, ni el FORCE, ni las politicas.
 * Se intento y se descarto: las migraciones declaran RLS dentro de bucles
 * (`for (const tabla of [...]) { ALTER TABLE ${tabla} ENABLE ... }`), y
 * reconstruir eso leyendo TypeScript con expresiones regulares da justo el tipo
 * de verde inventado que ya nos costo produccion dos veces. Nueve de las 46
 * politicas del repo no se ven con una regex; una lista incompleta que da verde
 * es peor que no tener test. Eso lo comprueba
 * `aislamiento-tenant.integration.spec.ts` contra el catalogo de PostgreSQL,
 * que no se equivoca — y que en CI corre siempre porque el job levanta Postgres
 * y aplica las migraciones antes de `npm test`.
 *
 * Leer el texto tiene un limite conocido y se acepta: si alguien crea una tabla
 * fuera de `migrations/`, aca no aparece. La prueba de integracion la ve igual,
 * porque parte del catalogo y no de los archivos.
 */
const CARPETA = join(__dirname, 'migrations');

interface TablaDeclarada {
  archivo: string;
  tieneTenantId: boolean;
}

/**
 * El cuerpo entre parentesis balanceados que abre en `desde`.
 *
 * Se llama SIEMPRE sobre texto sin comentarios `--`: un comentario con un
 * parentesis suelto ("-- ver issue (#28") descuadra la cuenta y se lleva por
 * delante el resto del archivo.
 */
function cuerpoBalanceado(texto: string, desde: number): string {
  let profundidad = 0;
  for (let i = desde; i < texto.length; i += 1) {
    if (texto[i] === '(') profundidad += 1;
    else if (texto[i] === ')') {
      profundidad -= 1;
      if (profundidad === 0) return texto.slice(desde + 1, i);
    }
  }
  return '';
}

/**
 * Las tablas que crean las migraciones, con si declaran `tenant_id`.
 *
 * Se lee solo `up()`: en `down()` estan los DROP y las tablas volverian a
 * "existir" al reves. Se quitan los comentarios `--` antes de nada porque el
 * repo los usa dentro del CREATE TABLE para explicar cada columna.
 */
function tablasDeclaradas(): Map<string, TablaDeclarada> {
  const tablas = new Map<string, TablaDeclarada>();
  const archivos = readdirSync(CARPETA)
    .filter((archivo) => archivo.endsWith('.ts') && !archivo.endsWith('.spec.ts'))
    .sort();

  for (const archivo of archivos) {
    const completo = readFileSync(join(CARPETA, archivo), 'utf8');
    const inicioDown = completo.indexOf('async down(');
    const subida = (inicioDown < 0 ? completo : completo.slice(0, inicioDown)).replace(
      /--[^\n]*/g,
      '',
    );

    for (const creacion of subida.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z_0-9]*)\s*\(/g,
    )) {
      const tabla = creacion[1] ?? '';
      if (tablas.has(tabla)) continue;
      const cuerpo = cuerpoBalanceado(subida, (creacion.index ?? 0) + creacion[0].length - 1);
      // `\b` no parte `target_tenant_id`, que es justo la columna con la que
      // tenant_deletions dice "hablo SOBRE una empresa, no pertenezco a una".
      tablas.set(tabla, { archivo, tieneTenantId: /\btenant_id\s/.test(cuerpo) });
    }

    // La columna tambien puede llegar despues, en otra migracion.
    for (const alta of subida.matchAll(
      /ALTER TABLE ([a-z_][a-z_0-9]*)\s+ADD COLUMN (?:IF NOT EXISTS )?tenant_id\b/g,
    )) {
      const declarada = tablas.get(alta[1] ?? '');
      if (declarada) declarada.tieneTenantId = true;
    }
  }

  return tablas;
}

describe('toda tabla del esquema dice de quien son sus filas', () => {
  const tablas = tablasDeclaradas();

  it('hay migraciones que leer', () => {
    // Canario del parser, no una regla de negocio: si un cambio de estilo en
    // las migraciones deja de casar con la expresion regular, el test daria
    // verde sin haber mirado nada. Esto lo convierte en rojo.
    expect(tablas.size).toBeGreaterThan(40);
  });

  it('ninguna tabla se queda sin tenant_id sin decir por que', () => {
    const sinJustificar = [...tablas]
      .filter(([tabla, { tieneTenantId }]) => !tieneTenantId && !TABLAS_SIN_TENANT_ID.has(tabla))
      .map(
        ([tabla, { archivo }]) =>
          `${tabla} (${archivo}): sin columna ${COLUMNA_TENANT}. Si guarda datos de una ` +
          `empresa, agregale ${COLUMNA_TENANT} + RLS; si de verdad es de plataforma, ` +
          `anotala en TABLAS_SIN_TENANT_ID con el motivo escrito.`,
      );

    expect(sinJustificar.sort()).toEqual([]);
  });

  it('la lista blanca no acumula entradas que ya no aplican', () => {
    // Una excepcion que sobrevive a su motivo es peor que ninguna: le da
    // permiso a una tabla que quiza hoy si tiene tenant_id y RLS de verdad.
    const obsoletas = [...TABLAS_SIN_TENANT_ID.keys()]
      .filter((tabla) => tablas.get(tabla)?.tieneTenantId !== false)
      .map((tabla) =>
        tablas.has(tabla)
          ? `${tabla}: ya tiene ${COLUMNA_TENANT}, sacala de TABLAS_SIN_TENANT_ID`
          : `${tabla}: ninguna migracion la crea, sacala de TABLAS_SIN_TENANT_ID`,
      );

    expect(obsoletas.sort()).toEqual([]);
  });

  it('cada excepcion trae un motivo, no una etiqueta', () => {
    // El valor de la lista blanca es lo que explica. "tabla de sistema" no
    // explica nada; el que la lea en seis meses tiene que poder decidir.
    const flojas = [...TABLAS_SIN_TENANT_ID]
      .filter(([, excepcion]) => excepcion.motivo.trim().length < 60)
      .map(([tabla]) => tabla);

    expect(flojas.sort()).toEqual([]);
  });

  it('las tablas con tenant_id se aislan por esa columna y las anotadas por la suya', () => {
    expect(columnaDeAislamiento('scans', true)).toBe(COLUMNA_TENANT);
    // tenants no tiene tenant_id: es la empresa, se aisla por su propio id.
    expect(columnaDeAislamiento('tenants', false)).toBe('id');
    // users se aisla por memberships, no por una columna suya: fuera del A/B.
    expect(columnaDeAislamiento('users', false)).toBeNull();
    expect(columnaDeAislamiento('roles', false)).toBeNull();
  });
});

describe('la expresion con la que se prueba el aislamiento sin datos', () => {
  const politica = (parcial: Partial<PoliticaDeTabla>): PoliticaDeTabla => ({
    nombre: 'p',
    permisiva: true,
    comando: 'ALL',
    usando: 'tenant_id = app_tenant_id()',
    conCheck: null,
    ...parcial,
  });

  it('sin ninguna politica no se ve nada: RLS niega por defecto', () => {
    expect(expresionDeVisibilidad([])).toBe('(false)');
  });

  it('una politica de INSERT no deja ver filas', () => {
    expect(expresionDeVisibilidad([politica({ comando: 'INSERT', usando: null })])).toBe('(false)');
  });

  it('las permisivas se suman con OR y las restrictivas con AND', () => {
    const expresion = expresionDeVisibilidad([
      politica({ nombre: 'a', usando: 'a' }),
      politica({ nombre: 'b', comando: 'SELECT', usando: 'b' }),
      politica({ nombre: 'c', permisiva: false, usando: 'c' }),
    ]);

    expect(expresion).toBe(
      '(coalesce((a), false) OR coalesce((b), false)) AND (coalesce((c), false))',
    );
  });

  it('una politica sin USING se representa como el agujero que es', () => {
    // No se disimula: `true` es exactamente lo que hace PostgreSQL, y ver ese
    // `true` en el mensaje del fallo es la mitad del diagnostico.
    expect(expresionDeVisibilidad([politica({ usando: null })])).toBe('(true)');
  });

  it('al escribir manda el WITH CHECK, y si falta se reutiliza el USING', () => {
    expect(expresionDeEscritura([politica({ conCheck: 'chk' })])).toBe('(coalesce((chk), false))');
    expect(expresionDeEscritura([politica({ usando: 'usa', conCheck: null })])).toBe(
      '(coalesce((usa), false))',
    );
    // DELETE no deja filas escritas: no participa.
    expect(expresionDeEscritura([politica({ comando: 'DELETE' })])).toBe('(false)');
  });

  it('la fila sintetica pone el tenant en su columna y NULL en el resto', () => {
    const sql = filaSintetica(
      'scans',
      [
        { nombre: 'id', tipo: 'uuid' },
        { nombre: 'tenant_id', tipo: 'uuid' },
        { nombre: 'scanned_at', tipo: 'timestamp with time zone' },
      ],
      COLUMNA_TENANT,
    );

    expect(sql).toBe(
      '(SELECT NULL::uuid AS "id", $1::uuid AS "tenant_id", ' +
        'NULL::timestamp with time zone AS "scanned_at") AS "scans"',
    );
  });

  it('el alias lleva el nombre de la tabla para que resuelva "tabla.columna"', () => {
    // users_isolation escribe `memberships.user_id = users.id`: sin el alias
    // la consulta ni siquiera compila y el fallo no diria nada util.
    const sql = consultaDeVisibilidad(
      'users',
      [{ nombre: 'id', tipo: 'uuid' }],
      [politica({ usando: 'users.id = app_user_id()' })],
      'id',
    );

    expect(sql).toBe(
      'SELECT (coalesce((users.id = app_user_id()), false)) AS visible\n' +
        'FROM (SELECT $1::uuid AS "id") AS "users"',
    );
  });
});
