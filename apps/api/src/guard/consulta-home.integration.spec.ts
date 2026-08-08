import { DataSource } from 'typeorm';

import { CONSULTA_HOME } from './guard.service';

/*
 * PREPARA la consulta de guard/home contra PostgreSQL DE VERDAD.
 *
 * PREPARE compila el plan sin ejecutar nada: valida sintaxis, columnas y tipos
 * sin necesitar datos. Es exactamente la clase de error que ningun mock puede
 * ver — un "= ANY(jsonb)" sobre expected_checkpoint_ids (que es JSONB, no
 * uuid[]) paso por TypeScript y por 1900 tests, se desplego, y guard/home
 * respondio 500 PARA TODOS LOS GUARDIAS en staging. Este spec lo caza en CI.
 *
 * Misma familia que el GROUP BY 42803 documentado en guard.service.spec.ts: la
 * base se comporta distinto de como el codigo cree, y la unica autoridad es la
 * base. Corre solo donde hay una (CI o local con infra levantada).
 */
const testUrl = process.env.DATABASE_TEST_URL;
const describeDatabase = testUrl ? describe : describe.skip;

describeDatabase('la consulta de guard/home compila en PostgreSQL real', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: testUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('PREPARE acepta la consulta: sintaxis, columnas y tipos contra el esquema migrado', async () => {
    await dataSource.query('DEALLOCATE ALL');
    // Si esto lanza, el error trae el mensaje real de PostgreSQL: la columna
    // que no existe, el tipo que no casa, el GROUP BY que falta.
    await dataSource.query(`PREPARE consulta_home (uuid) AS ${CONSULTA_HOME}`);
    await dataSource.query('DEALLOCATE consulta_home');
  });
});
