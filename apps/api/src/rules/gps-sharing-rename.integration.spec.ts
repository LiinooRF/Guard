import { Client } from 'pg';
import type { QueryRunner } from 'typeorm';

import { RenameGpsSharingMandatory1725994800000 } from '../database/migrations/1725994800000-RenameGpsSharingMandatory';

/**
 * El renombre del DATO, contra PostgreSQL de verdad.
 *
 * POR QUE HACE FALTA ESTE ARCHIVO Y NO BASTA gps-sharing-rename.migration.spec.ts
 * ------------------------------------------------------------------------------
 * Ese spec afirma sobre el TEXTO de la migracion: comprueba que la cadena
 * `WHERE jsonb_exists(overrides, $1::text)` esta escrita. Eso NO prueba que la
 * migracion sea idempotente — prueba que alguien escribio un WHERE. La promesa
 * del encabezado ("IDEMPOTENTE", "REVERSIBLE") nunca se habia ejecutado en
 * ninguna parte, y es justo la promesa cuyo incumplimiento deja a las empresas
 * con GPS opcional en obligatorio y a sus guardias sin poder iniciar la ronda.
 *
 * Aca se corre `up()` y `down()` de verdad y se mira el jsonb resultante.
 *
 * POR QUE TODO VA EN UNA TRANSACCION QUE SIEMPRE TERMINA EN ROLLBACK
 * -----------------------------------------------------------------
 * En CI la migracion YA se aplico (`db:migrate` corre antes que `npm test`), o
 * sea que las filas reales ya tienen la clave nueva. Un `down()` suelto se
 * llevaria por delante la configuracion sembrada de TODAS las empresas y
 * dejaria la base mintiendo para los specs que corran despues.
 *
 * El ROLLBACK tambien deshace el `DISABLE TRIGGER` y el `NO FORCE ROW LEVEL
 * SECURITY`, porque el DDL de PostgreSQL es transaccional. Es la misma propiedad
 * en la que la migracion se apoya para no necesitar un `finally`, asi que
 * probarla asi no es una comodidad del test: es el mismo mecanismo.
 *
 * `DATABASE_TEST_URL` es la credencial de migraciones, igual que en
 * tenant-isolation.integration.spec.ts: esta migracion corre como el dueño de
 * las tablas, no como sentrycore_app.
 */
const adminUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

const CLAVE_VIEJA = 'gpsSharingRequired';
const CLAVE_NUEVA = 'gpsSharingMandatory';

/** Regla vecina dentro del mismo jsonb: si el renombre la pierde, se ve aca. */
const VECINA = 'complianceThreshold';
const VALOR_VECINA = 77;

/**
 * Adapta un `Client` de pg a lo poco que la migracion usa del QueryRunner.
 *
 * Devuelve `result.rows` y no el `result` entero a proposito: es lo que TypeORM
 * entrega para un SELECT, y `contar()` lee `filas[0].filas`. Si esto devolviera
 * el objeto de pg, el conteo saldria `undefined` y el test pasaria por el motivo
 * equivocado.
 */
function comoQueryRunner(cliente: Client): QueryRunner {
  return {
    query: async (sql: string, parametros?: unknown[]) =>
      (await cliente.query(sql, parametros as unknown[] | undefined)).rows,
  } as unknown as QueryRunner;
}

/**
 * Primera fila de un resultado, o un error que dice que consulta se quedo vacia.
 *
 * El repo compila con `noUncheckedIndexedAccess`, asi que `rows[0]` es
 * `T | undefined` y no se puede leer sin mas. Un `!` lo callaria; esto ademas
 * convierte "el fixture no existe" en un mensaje legible en vez de un
 * "cannot read property of undefined" a treinta lineas del origen.
 */
function unaFila<T>(resultado: { rows: T[] }, queEra: string): T {
  const fila = resultado.rows[0];
  if (fila === undefined) throw new Error(`sin filas al leer ${queEra}`);
  return fila;
}

interface Fixture {
  tabla: string;
  /** Deja una fila con `overrides` = lo que se pida, y devuelve como leerla. */
  sembrar: (overrides: Record<string, unknown>) => Promise<void>;
  leer: () => Promise<Record<string, unknown>>;
  leerActualizado: () => Promise<string>;
}

describeDatabase('renombre de gpsSharingRequired: el dato guardado', () => {
  let admin: Client;
  let migracion: RenameGpsSharingMandatory1725994800000;
  let runner: QueryRunner;
  let fixtures: Fixture[];

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    migracion = new RenameGpsSharingMandatory1725994800000();
    runner = comoQueryRunner(admin);

    // Los padres se DESCUBREN, no se hardcodean: si el seed cambia sus UUID, el
    // test tiene que seguir valiendo o fallar diciendo que falta el seed, no
    // romperse por una constante vieja.
    const { rows: sitios } = await admin.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM sites ORDER BY id LIMIT 1`,
    );
    const { rows: puntos } = await admin.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM checkpoints ORDER BY id LIMIT 1`,
    );
    if (!sitios[0] || !puntos[0]) {
      throw new Error(
        'la base de pruebas no tiene recinto ni punto sembrados: sin eso este test ' +
          'no puede cubrir site_rules ni checkpoint_rules, y saltarlo en silencio ' +
          'es exactamente lo que esta migracion no puede permitirse.',
      );
    }
    const sitio = unaFila({ rows: sitios }, 'sites');
    const punto = unaFila({ rows: puntos }, 'checkpoints');

    const json = (o: Record<string, unknown>) => JSON.stringify(o);

    fixtures = [
      {
        tabla: 'platform_rules',
        // Fila unica garantizada por el CHECK del PK: se actualiza, no se inserta.
        sembrar: async (o) =>
          void (await admin.query(`UPDATE platform_rules SET overrides = $1::jsonb`, [json(o)])),
        leer: async () =>
          unaFila(
            await admin.query<{ overrides: Record<string, unknown> }>(
              `SELECT overrides FROM platform_rules`,
            ),
            'platform_rules.overrides',
          ).overrides,
        leerActualizado: async () =>
          unaFila(
            await admin.query<{ updated_at: Date }>(`SELECT updated_at FROM platform_rules`),
            'platform_rules.updated_at',
          ).updated_at.toISOString(),
      },
      {
        tabla: 'tenant_rules',
        sembrar: async (o) =>
          void (await admin.query(
            `INSERT INTO tenant_rules (tenant_id, overrides) VALUES ($1, $2::jsonb)
             ON CONFLICT (tenant_id) DO UPDATE SET overrides = EXCLUDED.overrides`,
            [sitio.tenant_id, json(o)],
          )),
        leer: async () =>
          unaFila(
            await admin.query<{ overrides: Record<string, unknown> }>(
              `SELECT overrides FROM tenant_rules WHERE tenant_id = $1`,
              [sitio.tenant_id],
            ),
            'tenant_rules.overrides',
          ).overrides,
        leerActualizado: async () =>
          unaFila(
            await admin.query<{ updated_at: Date }>(
              `SELECT updated_at FROM tenant_rules WHERE tenant_id = $1`,
              [sitio.tenant_id],
            ),
            'tenant_rules.updated_at',
          ).updated_at.toISOString(),
      },
      {
        tabla: 'site_rules',
        sembrar: async (o) =>
          void (await admin.query(
            `INSERT INTO site_rules (tenant_id, site_id, overrides) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (tenant_id, site_id) DO UPDATE SET overrides = EXCLUDED.overrides`,
            [sitio.tenant_id, sitio.id, json(o)],
          )),
        leer: async () =>
          unaFila(
            await admin.query<{ overrides: Record<string, unknown> }>(
              `SELECT overrides FROM site_rules WHERE tenant_id = $1 AND site_id = $2`,
              [sitio.tenant_id, sitio.id],
            ),
            'site_rules.overrides',
          ).overrides,
        leerActualizado: async () =>
          unaFila(
            await admin.query<{ updated_at: Date }>(
              `SELECT updated_at FROM site_rules WHERE tenant_id = $1 AND site_id = $2`,
              [sitio.tenant_id, sitio.id],
            ),
            'site_rules.updated_at',
          ).updated_at.toISOString(),
      },
      {
        tabla: 'checkpoint_rules',
        // Entra aunque la regla no sea configurable por punto: el objetivo es que
        // NO quede ninguna fila con el nombre viejo en ninguna parte.
        sembrar: async (o) =>
          void (await admin.query(
            `INSERT INTO checkpoint_rules (tenant_id, checkpoint_id, overrides)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (tenant_id, checkpoint_id) DO UPDATE SET overrides = EXCLUDED.overrides`,
            [punto.tenant_id, punto.id, json(o)],
          )),
        leer: async () =>
          unaFila(
            await admin.query<{ overrides: Record<string, unknown> }>(
              `SELECT overrides FROM checkpoint_rules WHERE tenant_id = $1 AND checkpoint_id = $2`,
              [punto.tenant_id, punto.id],
            ),
            'checkpoint_rules.overrides',
          ).overrides,
        leerActualizado: async () =>
          unaFila(
            await admin.query<{ updated_at: Date }>(
              `SELECT updated_at FROM checkpoint_rules WHERE tenant_id = $1 AND checkpoint_id = $2`,
              [punto.tenant_id, punto.id],
            ),
            'checkpoint_rules.updated_at',
          ).updated_at.toISOString(),
      },
    ];
  });

  afterAll(async () => {
    await admin.end();
  });

  // Nada de lo que hace un test sobrevive al siguiente NI a la corrida: en CI la
  // migracion ya se aplico sobre datos sembrados de verdad.
  beforeEach(async () => {
    await admin.query('BEGIN');
  });
  afterEach(async () => {
    await admin.query('ROLLBACK');
  });

  async function sembrarTodas(overrides: Record<string, unknown>): Promise<void> {
    for (const f of fixtures) await f.sembrar(overrides);
  }

  it('mueve el valor a la clave nueva en las CUATRO tablas de la cascada', async () => {
    // false = GPS OPCIONAL. Es el valor que importa: si el renombre lo pierde, la
    // fila vuelve al default del producto (true = obligatorio) y esa empresa
    // amanece bloqueando el inicio de ronda de quien niega el permiso.
    await sembrarTodas({ [CLAVE_VIEJA]: false, [VECINA]: VALOR_VECINA });

    await migracion.up(runner);

    for (const f of fixtures) {
      const overrides = await f.leer();
      expect({ tabla: f.tabla, ...overrides }).toEqual({
        tabla: f.tabla,
        [CLAVE_NUEVA]: false,
        [VECINA]: VALOR_VECINA,
      });
      expect(overrides).not.toHaveProperty(CLAVE_VIEJA);
    }
  });

  it('es IDEMPOTENTE: correrla dos veces deja exactamente lo mismo', async () => {
    await sembrarTodas({ [CLAVE_VIEJA]: false, [VECINA]: VALOR_VECINA });

    await migracion.up(runner);
    const trasLaPrimera = await Promise.all(fixtures.map((f) => f.leer()));
    const marcasPrimera = await Promise.all(fixtures.map((f) => f.leerActualizado()));

    await migracion.up(runner);
    const trasLaSegunda = await Promise.all(fixtures.map((f) => f.leer()));

    expect(trasLaSegunda).toEqual(trasLaPrimera);
    // Y la segunda pasada no toco ni una fila: si hubiera re-escrito, el trigger
    // de `updated_at` (o un SET olvidado) lo delataria.
    expect(await Promise.all(fixtures.map((f) => f.leerActualizado()))).toEqual(marcasPrimera);
  });

  it('es REVERSIBLE: down() devuelve la fila a como estaba, valor incluido', async () => {
    const original = { [CLAVE_VIEJA]: false, [VECINA]: VALOR_VECINA };
    await sembrarTodas(original);

    await migracion.up(runner);
    await migracion.down(runner);

    for (const f of fixtures) {
      expect(await f.leer()).toEqual(original);
    }
  });

  it('el viaje de ida y vuelta repetido no degrada el dato', async () => {
    const original = { [CLAVE_VIEJA]: true, [VECINA]: VALOR_VECINA };
    await sembrarTodas(original);

    for (let vuelta = 0; vuelta < 3; vuelta += 1) {
      await migracion.up(runner);
      await migracion.down(runner);
    }

    for (const f of fixtures) expect(await f.leer()).toEqual(original);
  });

  it('si una fila ya tenia la clave nueva, gana la NUEVA y se limpia la vieja', async () => {
    // Ambiente a medio migrar o re-corrida: el valor bueno es el que escribio el
    // codigo nuevo, no el que quedo colgando con el nombre viejo.
    await sembrarTodas({ [CLAVE_VIEJA]: true, [CLAVE_NUEVA]: false, [VECINA]: VALOR_VECINA });

    await migracion.up(runner);

    for (const f of fixtures) {
      expect(await f.leer()).toEqual({ [CLAVE_NUEVA]: false, [VECINA]: VALOR_VECINA });
    }
  });

  it('no inventa la clave en las filas que nunca la configuraron', async () => {
    // Sin fila u override, ese nivel "no opina" y el valor lo pone el de arriba.
    // Si la migracion escribiera la clave aca, le estaria fijando a esa empresa
    // un valor que nadie eligio.
    await sembrarTodas({ [VECINA]: VALOR_VECINA });

    await migracion.up(runner);

    for (const f of fixtures) {
      const overrides = await f.leer();
      expect(overrides).toEqual({ [VECINA]: VALOR_VECINA });
      expect(overrides).not.toHaveProperty(CLAVE_NUEVA);
    }
  });

  it('mueve el valor tal cual, sea cual sea: false, true y null de JSON', async () => {
    for (const valor of [false, true, null]) {
      await sembrarTodas({ [CLAVE_VIEJA]: valor });
      await migracion.up(runner);
      for (const f of fixtures) {
        expect(await f.leer()).toEqual({ [CLAVE_NUEVA]: valor });
      }
    }
  });

  it('no escribe ni una linea en el historial de configuracion', async () => {
    // Encendido el trigger, cada empresa recibiria dos filas diciendo que alguien
    // le cambio la regla de GPS la noche del despliegue — la pregunta exacta que
    // ese historial existe para responder bien.
    const contar = async () =>
      Number(
        unaFila(
          await admin.query<{ n: string }>(`SELECT count(*)::int AS n FROM config_change_log`),
          'config_change_log',
        ).n,
      );

    await sembrarTodas({ [CLAVE_VIEJA]: false });
    const antes = await contar();

    await migracion.up(runner);
    await migracion.down(runner);

    expect(await contar()).toBe(antes);
  });

  it('deja FORCE ROW LEVEL SECURITY como lo encontro en las tres tablas con tenant', async () => {
    // Si el renombre se olvidara de devolver FORCE, el aislamiento entre empresas
    // quedaria degradado para el dueño de la tabla a partir de ese despliegue, y
    // ningun test de RLS existente lo notaria: siguen viendo `relrowsecurity`.
    const forceDe = async (tabla: string) =>
      unaFila(
        await admin.query<{ relforcerowsecurity: boolean }>(
          `SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`,
          [tabla],
        ),
        `pg_class.${tabla}`,
      ).relforcerowsecurity;

    const tablas = ['tenant_rules', 'site_rules', 'checkpoint_rules'];
    const antes = await Promise.all(tablas.map(forceDe));
    expect(antes).toEqual([true, true, true]);

    await sembrarTodas({ [CLAVE_VIEJA]: false });
    await migracion.up(runner);

    expect(await Promise.all(tablas.map(forceDe))).toEqual([true, true, true]);
  });

  it('el trigger de auditoria queda habilitado despues de pasar', async () => {
    // `tgenabled` = 'O' es "origin", el estado normal; 'D' es deshabilitado. Si
    // la migracion se olvidara de reencenderlo, los cambios de configuracion
    // dejarian de auditarse para siempre y en silencio.
    const estadoDe = async (trigger: string) =>
      unaFila(
        await admin.query<{ tgenabled: string }>(
          `SELECT tgenabled FROM pg_trigger WHERE tgname = $1`,
          [trigger],
        ),
        `pg_trigger.${trigger}`,
      ).tgenabled;

    await sembrarTodas({ [CLAVE_VIEJA]: false });
    await migracion.up(runner);

    for (const tabla of ['platform_rules', 'tenant_rules', 'site_rules', 'checkpoint_rules']) {
      expect(await estadoDe(`${tabla}_config_audit`)).toBe('O');
    }
  });
});
