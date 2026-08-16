import { DataSource, type QueryRunner } from 'typeorm';

import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import {
  SQL_FOTOS_DE_LA_RONDA,
  SQL_PUNTOS_ESPERADOS,
  SQL_TAREAS_DEL_TURNO,
} from './patrol-report.service';

const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const ADMIN = 'a0000000-0000-4000-8000-000000000009';

/**
 * El camino de los informes contra el esquema REAL.
 *
 * Existe por un bug concreto: `forDocuments()` hacia `SELECT name FROM tenants`
 * y esa columna no existe —la tabla tiene legal_name y display_name—, asi que
 * TODOS los informes en PDF daban 500 en produccion. Los tests unitarios
 * pasaban porque el mock devolvia `{ name: '...' }`: una columna inventada.
 *
 * Ese es el punto ciego que cubre este archivo. Un mock confirma lo que el
 * autor ya creia; solo la base dice si la consulta existe de verdad.
 */
describeDatabase('camino de informes (esquema real)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function enTenant<T>(
    operacion: (contexto: TenantContextService, runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [TENANT, ADMIN],
      );
      const contexto = new TenantContextService();
      return await contexto.run(runner, () => operacion(contexto, runner));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('la marca para documentos se resuelve contra la tabla de verdad', async () => {
    const marca = await enTenant(async (contexto) =>
      new BrandingService(contexto).forDocuments(),
    );
    // Lo que importa no es QUE nombre trae, sino que la consulta corrio: con la
    // columna equivocada esto lanzaba y se llevaba puesto todo informe.
    expect(typeof marca.displayName).toBe('string');
    expect(marca.displayName.length).toBeGreaterThan(0);
    expect(marca).toHaveProperty('primaryColor');
    expect(marca).toHaveProperty('mailFromName');
  });

  it('sin marca configurada cae al nombre del tenant, no a un vacio', async () => {
    const marca = await enTenant(async (contexto, runner) => {
      await runner.query(`DELETE FROM tenant_branding WHERE tenant_id = app_tenant_id()`);
      return new BrandingService(contexto).forDocuments();
    });
    expect(marca.displayName).not.toBe('');
    // 'VoxIA Control' es el ultimo recurso: si sale eso, el tenant no se leyo.
    expect(marca.displayName).not.toBe('VoxIA Control');
  });

  it('la marca del tenant tambien se lee entera sin reventar', async () => {
    const branding = await enTenant(async (contexto) => new BrandingService(contexto).current());
    expect(branding.primaryColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  /**
   * Guardia general contra la MISMA clase de error en cualquier otra consulta.
   * No prueba una funcionalidad: prueba que el codigo y el esquema no se hayan
   * separado. Si alguien renombra una columna de tenants, esto lo dice aca y no
   * en el primer informe que pida un cliente.
   */
  it('tenants conserva las columnas que el codigo consulta por nombre', async () => {
    // QueryRunner.query no acepta parametro de tipo (a diferencia del
    // EntityManager), de ahi el cast.
    const filas = (await enTenant(async (_c, runner) =>
      runner.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'tenants' AND table_schema = 'public'`,
      ),
    )) as Array<{ column_name: string }>;
    const columnas = new Set(filas.map((f) => f.column_name));
    for (const esperada of ['id', 'slug', 'legal_name', 'display_name', 'status']) {
      expect(columnas.has(esperada)).toBe(true);
    }
    // No existe y nunca existio: dejarlo escrito evita que alguien la
    // reintroduzca "para simplificar" y rompa lo mismo otra vez.
    expect(columnas.has('name')).toBe(false);
  });

  /**
   * La consulta de tareas del turno (#265) contra el esquema de verdad.
   *
   * Corre EL MISMO texto que usa el servicio. Es la unica forma de saber que
   * `due_local_time`, `requires_photo` y `late_minutes` existen con ese nombre:
   * el mock del test unitario devuelve lo que el autor escribio, asi que
   * confirmaria una columna inventada sin pestañear.
   */
  it('la consulta de tareas del turno corre contra el esquema real', async () => {
    const filas = (await enTenant(async (_c, runner) =>
      // Una ronda que no existe: se prueba que la consulta es valida y devuelve
      // vacio, que es tambien el camino de la ronda sin checklist.
      runner.query(SQL_TAREAS_DEL_TURNO, ['00000000-0000-4000-8000-000000000000']),
    )) as unknown[];

    expect(filas).toEqual([]);
  });

  /**
   * Las dos columnas que #308 agrego a consultas que ya existian:
   * `checkpoints.instructions` (la linea "Instrucciones:" de la bitacora) y
   * `scan_photos.scan_id` (para agrupar la evidencia de una misma lectura).
   *
   * Las dos existen en la base desde su migracion inicial y el informe
   * simplemente no las leia. Aun asi van contra PostgreSQL y no contra el mock:
   * el mock del spec unitario devuelve lo que el autor escribio, asi que
   * confirmaria una columna inventada sin pestañear. Es el bug que ya llego a
   * staging con CI en verde.
   */
  it('la consulta de puntos esperados corre contra el esquema real', async () => {
    const filas = (await enTenant(async (_c, runner) =>
      runner.query(SQL_PUNTOS_ESPERADOS, ['00000000-0000-4000-8000-000000000000']),
    )) as unknown[];

    expect(filas).toEqual([]);
  });

  it('la consulta de evidencia de la ronda corre contra el esquema real', async () => {
    const filas = (await enTenant(async (_c, runner) =>
      runner.query(SQL_FOTOS_DE_LA_RONDA, ['00000000-0000-4000-8000-000000000000']),
    )) as unknown[];

    expect(filas).toEqual([]);
  });

  it('checkpoints y scan_photos conservan las columnas que el informe consulta', async () => {
    const columnasDe = async (tabla: string) => {
      const filas = (await enTenant(async (_c, runner) =>
        runner.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'`,
          [tabla],
        ),
      )) as Array<{ column_name: string }>;
      return new Set(filas.map((f) => f.column_name));
    };

    const checkpoints = await columnasDe('checkpoints');
    for (const esperada of ['instructions', 'description', 'kind', 'name']) {
      expect(checkpoints.has(esperada)).toBe(true);
    }
    const fotos = await columnasDe('scan_photos');
    for (const esperada of ['scan_id', 'checkpoint_id', 'sha256', 'taken_at_device']) {
      expect(fotos.has(esperada)).toBe(true);
    }
  });
});
