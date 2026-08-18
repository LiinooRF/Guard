import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SQL_ASIGNAR_TARJETA_NFC_ADMIN } from '../admin/admin.service';
import { SQL_RECINTO_ASIGNADO_DEL_GUARDIA } from '../guard/guard.service';
import { SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR } from '../supervisor/supervisor.service';

/**
 * Que PostgreSQL pueda DEDUCIR EL TIPO de cada parametro ligado.
 *
 * El bug que motiva esto: asignar una tarjeta NFC desde el panel devolvia 500
 * en produccion. La sentencia era
 *
 *   UPDATE users SET nfc_card_uid = $2,
 *     nfc_card_assigned_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE NULL END
 *
 * y PostgreSQL contestaba `42P08 could not determine data type of parameter $2`:
 * dentro de `IS NOT NULL` un parametro no tiene de donde tomar tipo.
 *
 * Por que se escapo de TODAS las pruebas que ya existian:
 *
 * - Los tests con mock no ven la base: comprueban que se llamo a `query` con
 *   cierta cadena, no que PostgreSQL la acepte.
 * - Probarla a mano en `psql` con literales **pasa**. El error solo aparece con
 *   parametros ligados, o sea por el protocolo extendido, que es exactamente
 *   el que usa la aplicacion y ninguna prueba usaba.
 *
 * No hace falta que la fila exista ni que haya contexto de tenant: el fallo
 * ocurre al analizar la sentencia, antes de tocar un solo registro. Por eso
 * esto corre con un UUID inventado y espera CERO filas afectadas — lo que se
 * mide es que el servidor la acepte, no que actualice.
 *
 * Si agregas una sentencia con un parametro dentro de `IS NULL`, `IS NOT NULL`
 * o como condicion de un `CASE`, sumala aqui y ponle el `::tipo`.
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

/** Un hash de argon2id con la forma que exige el CHECK de `users`. */
const HASH_ARGON2ID =
  '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHR2YWx1ZQ$0123456789abcdef0123456789abcdef0123456789ab';

describeDatabase('parametros ligados que PostgreSQL debe poder tipar', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /** Ejecuta la sentencia y deshace todo: lo que interesa es si el servidor la acepta. */
  async function aceptaLaSentencia(sql: string, parametros: unknown[]): Promise<void> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(sql, parametros);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  const casos: Array<[string, string, unknown[]]> = [
    ['admin · asignar tarjeta', SQL_ASIGNAR_TARJETA_NFC_ADMIN, [randomUUID(), '04A1B2C3D4']],
    ['admin · quitar tarjeta', SQL_ASIGNAR_TARJETA_NFC_ADMIN, [randomUUID(), null]],
    [
      'supervisor · asignar tarjeta y PIN',
      SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR,
      [randomUUID(), '04A1B2C3D4', true, HASH_ARGON2ID],
    ],
    [
      'supervisor · asignar tarjeta sin tocar el PIN',
      SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR,
      [randomUUID(), '04A1B2C3D4', false, null],
    ],
    [
      'supervisor · quitar tarjeta y PIN',
      SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR,
      [randomUUID(), null, true, null],
    ],
    // El panico de un guardia sin GPS: los dos parametros de coordenada llegan
    // en NULL y solo aparecen dentro de un `IS NULL`. Sin `::float8` esto es
    // un 42P08 y el boton de panico devuelve 500.
    [
      'guardia · recinto del panico sin coordenadas',
      SQL_RECINTO_ASIGNADO_DEL_GUARDIA,
      [randomUUID(), null, null],
    ],
    [
      'guardia · recinto del panico con coordenadas',
      SQL_RECINTO_ASIGNADO_DEL_GUARDIA,
      [randomUUID(), -33.45, -70.66],
    ],
  ];

  it.each(casos)('PostgreSQL acepta la sentencia de %s', async (_nombre, sql, parametros) => {
    await expect(aceptaLaSentencia(sql, parametros)).resolves.toBeUndefined();
  });
});
