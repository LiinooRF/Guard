import { Client } from 'pg';

import {
  COLUMNA_TENANT,
  TABLA_DE_CONTROL_TYPEORM,
  TABLAS_SIN_TENANT_ID,
  columnaDeAislamiento,
  consultaDeEscritura,
  consultaDeVisibilidad,
  politicasDeLectura,
  type ColumnaDeTabla,
  type PoliticaDeTabla,
} from './aislamiento-tenant';

/**
 * El aislamiento entre empresas, comprobado tabla por tabla contra el catalogo
 * de PostgreSQL (#218).
 *
 * QUE APORTA SOBRE LO QUE YA HABIA
 * --------------------------------
 * `tenant-isolation.integration.spec.ts` ya descubre las tablas con
 * `tenant_id` y lee de cada una con el rol de la aplicacion. Le faltaban tres
 * cosas, y las tres son la razon de este archivo:
 *
 * 1. Solo mira las tablas que YA tienen `tenant_id`. Una tabla nueva que se
 *    olvide la columna es justo la que no aparece en esa consulta: el test que
 *    deberia atraparla es ciego a ella por construccion. Aca se parte de TODAS
 *    las tablas del esquema y se exige `tenant_id` o una excepcion escrita.
 * 2. Lee filas sembradas, y despues del seed 45 de las 53 tablas con
 *    `tenant_id` estan vacias: sobre esas 45 "el tenant A no vio filas de B"
 *    se cumple porque no hay filas de nadie. Aca no hace falta sembrar: se le
 *    da a la politica una fila IMAGINARIA de la otra empresa y se le pregunta
 *    a PostgreSQL si la dejaria ver. Sobre la misma fila imaginaria se
 *    comprueba el control positivo (la propia SI se ve), sin el cual el test
 *    pasaria por vacio.
 * 3. `tenants` no tiene columna `tenant_id`, asi que la tabla que define la
 *    empresa quedaba fuera del recorrido. Entra por `columnaDeAislamiento`.
 *
 * LO QUE SIGUE VIVIENDO EN EL OTRO ARCHIVO
 * ---------------------------------------
 * La lectura de filas de verdad con el rol restringido y el UPDATE cruzado.
 * Son la prueba de punta a punta sobre las tablas que si tienen datos; esto
 * otro es la prueba de que la REGLA escrita en cada politica dice lo que hay
 * que decir, tenga datos o no. Se complementan y por eso no se borro ninguna.
 *
 * POR QUE EVALUAR LA POLITICA Y NO SOLO LEER
 * -----------------------------------------
 * `pg_policies.qual` es la expresion tal como la guarda PostgreSQL, no la que
 * creemos haber escrito. Evaluarla contra una fila armada a mano contesta la
 * pregunta exacta —"con el contexto de A, esta fila de B pasa el filtro?"—
 * para toda tabla por igual y sin depender de datos.
 */
const urlAdmin = process.env.DATABASE_TEST_URL;
const urlApp = process.env.DATABASE_APP_TEST_URL;
const describirConBase = urlAdmin && urlApp ? describe : describe.skip;

/** Las dos empresas del seed. Cualquier par de uuid distintos serviria. */
const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000001';

interface TablaDelEsquema {
  nombre: string;
  rlsActiva: boolean;
  rlsForzada: boolean;
  tieneTenantId: boolean;
}

/** Como quedo una fila imaginaria frente a las politicas de su tabla. */
interface Veredicto {
  propia: boolean | null;
  ajena: boolean | null;
  /** El error de PostgreSQL, si la expresion ni siquiera se pudo evaluar. */
  error?: string;
}

describirConBase('aislamiento por empresa de todo el esquema', () => {
  let admin: Client;
  let app: Client;
  let rolApp: string;

  let tablas: TablaDelEsquema[] = [];
  let columnas = new Map<string, ColumnaDeTabla[]>();
  let politicas = new Map<string, PoliticaDeTabla[]>();
  /** Las tablas que tienen por donde aislarse, con esa columna. */
  let aislables: { tabla: TablaDelEsquema; columna: string }[] = [];

  const lecturaConContexto = new Map<string, Veredicto>();
  const lecturaSinContexto = new Map<string, Veredicto>();
  const escrituraConContexto = new Map<string, Veredicto>();

  /**
   * Abre una transaccion con el contexto de empresa pedido y la deshace al
   * salir. `set_config(..., true)` es local a la transaccion: al hacer
   * ROLLBACK no queda contexto colgando para la siguiente.
   */
  async function conContexto<T>(tenantId: string | null, cuerpo: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      // La cadena vacia es lo mismo que no tenerlo: app_tenant_id() la
      // convierte en NULL con NULLIF. Asi se prueba la falla cerrada.
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId ?? '']);
      return await cuerpo();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  /** Evalua una consulta booleana para la fila imaginaria de cada empresa. */
  async function veredicto(sql: string, columna: string): Promise<Veredicto> {
    try {
      const propia = await app.query<Record<string, boolean>>(sql, [TENANT_A]);
      const ajena = await app.query<Record<string, boolean>>(sql, [TENANT_B]);
      return {
        propia: propia.rows[0]?.[columna] ?? null,
        ajena: ajena.rows[0]?.[columna] ?? null,
      };
    } catch (error) {
      // Un fallo al evaluar tambien es informacion: se reporta con el nombre
      // de la tabla en vez de tumbar la corrida entera sin decir cual.
      return { propia: null, ajena: null, error: (error as Error).message };
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: urlAdmin });
    app = new Client({ connectionString: urlApp });
    await Promise.all([admin.connect(), app.connect()]);

    rolApp = (await app.query<{ rol: string }>('SELECT current_user AS rol')).rows[0]?.rol ?? '';

    // relkind 'r' = tabla comun, 'p' = particionada. Las vistas no llevan RLS
    // propia: heredan la de las tablas que leen.
    const catalogo = await admin.query<{
      nombre: string;
      rls_activa: boolean;
      rls_forzada: boolean;
      tiene_tenant_id: boolean;
    }>(`
      SELECT clase.relname AS nombre,
             clase.relrowsecurity AS rls_activa,
             clase.relforcerowsecurity AS rls_forzada,
             EXISTS (
               SELECT 1 FROM pg_attribute atributo
               WHERE atributo.attrelid = clase.oid
                 AND atributo.attname = '${COLUMNA_TENANT}'
                 AND atributo.attnum > 0
                 AND NOT atributo.attisdropped
             ) AS tiene_tenant_id
      FROM pg_class clase
      JOIN pg_namespace espacio ON espacio.oid = clase.relnamespace
      WHERE espacio.nspname = 'public'
        AND clase.relkind IN ('r', 'p')
        AND clase.relname <> '${TABLA_DE_CONTROL_TYPEORM}'
      ORDER BY clase.relname
    `);
    tablas = catalogo.rows.map((fila) => ({
      nombre: fila.nombre,
      rlsActiva: fila.rls_activa,
      rlsForzada: fila.rls_forzada,
      tieneTenantId: fila.tiene_tenant_id,
    }));

    const columnasDelEsquema = await admin.query<{
      tabla: string;
      nombre: string;
      tipo: string;
    }>(`
      SELECT clase.relname AS tabla,
             atributo.attname AS nombre,
             format_type(atributo.atttypid, atributo.atttypmod) AS tipo
      FROM pg_attribute atributo
      JOIN pg_class clase ON clase.oid = atributo.attrelid
      JOIN pg_namespace espacio ON espacio.oid = clase.relnamespace
      WHERE espacio.nspname = 'public'
        AND clase.relkind IN ('r', 'p')
        AND atributo.attnum > 0
        AND NOT atributo.attisdropped
      ORDER BY clase.relname, atributo.attnum
    `);
    columnas = new Map();
    for (const fila of columnasDelEsquema.rows) {
      const lista = columnas.get(fila.tabla) ?? [];
      lista.push({ nombre: fila.nombre, tipo: fila.tipo });
      columnas.set(fila.tabla, lista);
    }

    const politicasDelEsquema = await admin.query<{
      tabla: string;
      nombre: string;
      permisiva: string;
      comando: string;
      usando: string | null;
      con_check: string | null;
      roles: string[];
    }>(`
      SELECT tablename AS tabla,
             policyname AS nombre,
             permissive AS permisiva,
             cmd AS comando,
             qual AS usando,
             with_check AS con_check,
             roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);
    politicas = new Map();
    for (const fila of politicasDelEsquema.rows) {
      // Una politica que apunta a OTRO rol no protege ni estorba al de la
      // aplicacion: contarla daria un aislamiento que en realidad no existe.
      if (!fila.roles.includes('public') && !fila.roles.includes(rolApp)) continue;
      const lista = politicas.get(fila.tabla) ?? [];
      lista.push({
        nombre: fila.nombre,
        permisiva: fila.permisiva === 'PERMISSIVE',
        comando: fila.comando,
        usando: fila.usando,
        conCheck: fila.con_check,
      });
      politicas.set(fila.tabla, lista);
    }

    aislables = tablas
      .map((tabla) => ({
        tabla,
        columna: columnaDeAislamiento(tabla.nombre, tabla.tieneTenantId),
      }))
      .filter((entrada): entrada is { tabla: TablaDelEsquema; columna: string } =>
        Boolean(entrada.columna),
      );

    await conContexto(TENANT_A, async () => {
      for (const { tabla, columna } of aislables) {
        const cols = columnas.get(tabla.nombre) ?? [];
        const pols = politicas.get(tabla.nombre) ?? [];
        lecturaConContexto.set(
          tabla.nombre,
          await veredicto(consultaDeVisibilidad(tabla.nombre, cols, pols, columna), 'visible'),
        );
        escrituraConContexto.set(
          tabla.nombre,
          await veredicto(consultaDeEscritura(tabla.nombre, cols, pols, columna), 'aceptada'),
        );
      }
    });

    await conContexto(null, async () => {
      for (const { tabla, columna } of aislables) {
        lecturaSinContexto.set(
          tabla.nombre,
          await veredicto(
            consultaDeVisibilidad(
              tabla.nombre,
              columnas.get(tabla.nombre) ?? [],
              politicas.get(tabla.nombre) ?? [],
              columna,
            ),
            'visible',
          ),
        );
      }
    });
  });

  afterAll(async () => {
    await Promise.all([admin?.end(), app?.end()]);
  });

  it('el esquema tiene tablas que revisar', () => {
    // Canario: si la consulta al catalogo dejara de devolver filas, todo lo
    // demas pasaria por vacio.
    expect(tablas.length).toBeGreaterThan(40);
    expect(aislables.length).toBeGreaterThan(40);
  });

  it('el rol de la aplicacion no puede saltarse RLS', async () => {
    // Sin esto, todo lo que sigue seria decorativo: el dueño de la tabla y
    // cualquier rol con BYPASSRLS ignoran las politicas.
    const { rows } = await admin.query<{ bypass: boolean; superusuario: boolean }>(
      `SELECT rolbypassrls AS bypass, rolsuper AS superusuario FROM pg_roles WHERE rolname = $1`,
      [rolApp],
    );
    expect(rows[0]).toEqual({ bypass: false, superusuario: false });
  });

  it('cada tabla dice de quien son sus filas', () => {
    const sinJustificar = tablas
      .filter((tabla) => !tabla.tieneTenantId && !TABLAS_SIN_TENANT_ID.has(tabla.nombre))
      .map(
        (tabla) =>
          `${tabla.nombre}: no tiene columna ${COLUMNA_TENANT}. Si guarda datos de una ` +
          `empresa, agregale ${COLUMNA_TENANT} + RLS en una migracion; si es de ` +
          `plataforma, anotala en TABLAS_SIN_TENANT_ID con el motivo escrito.`,
      );

    expect(sinJustificar).toEqual([]);
  });

  it('la lista blanca no acumula entradas que ya no aplican', () => {
    const nombres = new Set(tablas.map((tabla) => tabla.nombre));
    const conTenantId = new Set(
      tablas.filter((tabla) => tabla.tieneTenantId).map((tabla) => tabla.nombre),
    );

    const obsoletas = [...TABLAS_SIN_TENANT_ID.keys()]
      .filter((tabla) => !nombres.has(tabla) || conTenantId.has(tabla))
      .map((tabla) =>
        conTenantId.has(tabla)
          ? `${tabla}: ya tiene ${COLUMNA_TENANT}, sacala de TABLAS_SIN_TENANT_ID`
          : `${tabla}: no existe en el esquema, sacala de TABLAS_SIN_TENANT_ID`,
      );

    expect(obsoletas).toEqual([]);
  });

  it('la columna alternativa de aislamiento existe de verdad', () => {
    // `tenants` se aisla por `id`. Si alguien renombra esa columna, la prueba
    // A/B de la tabla mas importante del producto se apagaria en silencio.
    const inexistentes = [...TABLAS_SIN_TENANT_ID]
      .filter(([, excepcion]) => excepcion.columnaDeAislamiento)
      .filter(
        ([tabla, excepcion]) =>
          !(columnas.get(tabla) ?? []).some(
            (columna) => columna.nombre === excepcion.columnaDeAislamiento,
          ),
      )
      .map(([tabla, excepcion]) => `${tabla}.${excepcion.columnaDeAislamiento} no existe`);

    expect(inexistentes).toEqual([]);
  });

  it('toda tabla con datos de empresa tiene RLS con ENABLE y FORCE', () => {
    // FORCE no es un extra: sin el, el dueño de la tabla se salta sus propias
    // politicas, y las migraciones y el seed corren justamente como dueño.
    const flojas = aislables
      .filter(({ tabla }) => !tabla.rlsActiva || !tabla.rlsForzada)
      .map(({ tabla }) => {
        const falta = [
          tabla.rlsActiva ? null : 'ENABLE ROW LEVEL SECURITY',
          tabla.rlsForzada ? null : 'FORCE ROW LEVEL SECURITY',
        ].filter(Boolean);
        return `${tabla.nombre}: le falta ${falta.join(' y ')}`;
      });

    expect(flojas).toEqual([]);
  });

  it('toda tabla aislada tiene al menos una politica de lectura', () => {
    const mudas = aislables
      .filter(({ tabla }) => politicasDeLectura(politicas.get(tabla.nombre) ?? []).length === 0)
      .map(
        ({ tabla }) =>
          `${tabla.nombre}: ninguna politica de SELECT o ALL que aplique a ${rolApp}. ` +
          `Con RLS forzada eso deja la tabla invisible para la aplicacion, que casi ` +
          `nunca es lo que se buscaba.`,
      );

    expect(mudas).toEqual([]);
  });

  it('el tenant A no ve ni una fila del tenant B', () => {
    const filtradas = aislables
      .map(({ tabla, columna }) => {
        const resultado = lecturaConContexto.get(tabla.nombre);
        if (resultado?.error) return `${tabla.nombre}: no se pudo evaluar (${resultado.error})`;
        if (resultado?.ajena !== false) {
          return (
            `${tabla.nombre}: con el contexto de una empresa, una fila con ` +
            `${columna} de OTRA empresa pasa el filtro de lectura. Revisa su politica: ` +
            `tiene que comparar ${columna} con app_tenant_id().`
          );
        }
        return null;
      })
      .filter((mensaje): mensaje is string => mensaje !== null);

    expect(filtradas).toEqual([]);
  });

  it('y si ve las suyas, o la prueba anterior no estaria probando nada', () => {
    // Control positivo. Una politica `USING (false)` esconderia los datos de
    // todos y la comprobacion de arriba pasaria feliz.
    const ciegas = aislables
      .filter(({ tabla }) => lecturaConContexto.get(tabla.nombre)?.propia !== true)
      .map(
        ({ tabla, columna }) =>
          `${tabla.nombre}: con su propio contexto tampoco ve una fila con ${columna} propio`,
      );

    expect(ciegas).toEqual([]);
  });

  it('sin contexto de empresa no se ve nada: las politicas fallan cerradas', () => {
    // El patron obligatorio es NULLIF(current_setting('app.tenant_id', true), '')::uuid
    // —lo que hace app_tenant_id()—: sin contexto da NULL, la comparacion da
    // NULL y la fila no pasa. Una politica que use current_setting() a secas
    // revienta o, peor, abre.
    const abiertas = aislables
      .map(({ tabla }) => {
        const resultado = lecturaSinContexto.get(tabla.nombre);
        if (resultado?.error) return `${tabla.nombre}: no se pudo evaluar (${resultado.error})`;
        if (resultado?.propia !== false || resultado?.ajena !== false) {
          return `${tabla.nombre}: sin app.tenant_id la politica todavia deja ver filas`;
        }
        return null;
      })
      .filter((mensaje): mensaje is string => mensaje !== null);

    expect(abiertas).toEqual([]);
  });

  it('ninguna empresa puede dejar una fila con el tenant de otra', () => {
    // La otra mitad del aislamiento: el WITH CHECK. Sin el, una empresa lee
    // solo lo suyo pero puede empujar filas al vecino.
    const permisivas = aislables
      .map(({ tabla, columna }) => {
        const resultado = escrituraConContexto.get(tabla.nombre);
        if (resultado?.error) return `${tabla.nombre}: no se pudo evaluar (${resultado.error})`;
        if (resultado?.ajena !== false) {
          return (
            `${tabla.nombre}: con el contexto de una empresa se aceptaria escribir una ` +
            `fila con ${columna} de otra. Falta WITH CHECK (${columna} = app_tenant_id()).`
          );
        }
        return null;
      })
      .filter((mensaje): mensaje is string => mensaje !== null);

    expect(permisivas).toEqual([]);
  });
});
