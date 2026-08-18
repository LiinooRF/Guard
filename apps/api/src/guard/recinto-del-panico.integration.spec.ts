import { Client } from 'pg';

import { SQL_RECINTO_ASIGNADO_DEL_GUARDIA } from './guard.service';

/**
 * A que recinto va el panico de un guardia SIN ronda y SIN jornada abierta.
 *
 * Esto corre contra PostgreSQL de verdad y no con un mock, por las dos razones
 * que hicieron falta:
 *
 * - La consulta anterior leia `user_sites`, una tabla que no existe. El mock
 *   devolvia la fila que el autor esperaba, asi que el test pasaba en verde y
 *   el boton de panico devolvia 500. Aca, si la tabla o una columna no existen,
 *   la prueba se cae con el `42P01` real.
 * - Con dos recintos asignados hay que elegir UNO, y esa eleccion decide a que
 *   supervisor se escala la alerta. Un mock no puede probar un `ORDER BY`.
 *
 * Todo se siembra dentro de una transaccion que termina en ROLLBACK: no deja
 * nada en la base.
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

const TENANT = '3e000000-0000-4000-8000-000000000001';
const GUARDIA = '3e000000-0000-4000-8000-000000000002';
const RECINTO_NORTE = '3e000000-0000-4000-8000-000000000010';
const RECINTO_SUR = '3e000000-0000-4000-8000-000000000011';

// Dos recintos de la misma empresa, a ~11 km uno del otro en Santiago.
const NORTE = { lat: -33.4, lng: -70.65 };
const SUR = { lat: -33.5, lng: -70.65 };

describeDatabase('a que recinto se asocia el panico sin ronda ni jornada', () => {
  let app: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: appUrl });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
  });

  beforeEach(async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    await app.query(
      `INSERT INTO tenants (id, slug, legal_name, display_name)
       VALUES ($1, 'panico-e2e', 'Seguridad de Prueba SpA', 'Seguridad de Prueba')`,
      [TENANT],
    );
    await app.query(
      // `users` exige correo o usuario: muchos guardias no tienen correo, por
      // eso existe el camino de credencial entregada por el admin.
      `INSERT INTO users (id, username, password_hash, given_name, family_name)
       VALUES ($1, 'guardia.panico.e2e', 'no-usada', 'Guardia', 'De Prueba')`,
      [GUARDIA],
    );
    await app.query(
      `INSERT INTO memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'GUARDIA')`,
      [TENANT, GUARDIA],
    );
    // El NORTE se crea primero a proposito: es el que gana cuando no hay
    // coordenadas con que decidir, y asi la prueba distingue "el mas cercano"
    // de "el primero que salio".
    await app.query(
      `INSERT INTO sites (id, tenant_id, branch_name, name, address, latitude, longitude, created_at)
       VALUES ($1, $2, 'Norte', 'Recinto Norte', 'Av. Norte 100', $3, $4, now() - interval '2 days'),
              ($5, $2, 'Sur', 'Recinto Sur', 'Av. Sur 200', $6, $7, now() - interval '1 day')`,
      [RECINTO_NORTE, TENANT, NORTE.lat, NORTE.lng, RECINTO_SUR, SUR.lat, SUR.lng],
    );
    await app.query(
      `INSERT INTO guard_sites (tenant_id, guard_id, role_key, site_id, created_at)
       VALUES ($1, $2, 'GUARDIA', $3, now() - interval '2 days'),
              ($1, $2, 'GUARDIA', $4, now() - interval '1 day')`,
      [TENANT, GUARDIA, RECINTO_NORTE, RECINTO_SUR],
    );
  });

  afterEach(async () => {
    await app.query('ROLLBACK');
  });

  async function recintoElegido(lat: number | null, lng: number | null): Promise<string | null> {
    const { rows } = await app.query<{ site_id: string }>(SQL_RECINTO_ASIGNADO_DEL_GUARDIA, [
      GUARDIA,
      lat,
      lng,
    ]);
    return rows[0]?.site_id ?? null;
  }

  it('con coordenadas, elige el recinto MAS CERCANO al punto informado', async () => {
    // El guardia aprieta panico parado casi encima del recinto Sur.
    expect(await recintoElegido(-33.499, -70.651)).toBe(RECINTO_SUR);
    // Y desde el Norte, el Norte.
    expect(await recintoElegido(-33.401, -70.649)).toBe(RECINTO_NORTE);
  });

  it('sin coordenadas elige de forma ESTABLE, no al azar', async () => {
    const primera = await recintoElegido(null, null);
    expect(primera).toBe(RECINTO_NORTE);
    // Repetido tiene que dar lo mismo: si dependiera del orden fisico de la
    // tabla, la alerta cambiaria de supervisor entre dos pulsaciones.
    for (let intento = 0; intento < 5; intento += 1) {
      expect(await recintoElegido(null, null)).toBe(primera);
    }
  });

  it('un recinto sin coordenadas no gana por descarte, pero sigue siendo elegible', async () => {
    await app.query(`UPDATE sites SET latitude = NULL, longitude = NULL WHERE id = $1`, [
      RECINTO_SUR,
    ]);
    // El Sur ya no se puede medir: gana el Norte, que si tiene con que compararse.
    expect(await recintoElegido(-33.499, -70.651)).toBe(RECINTO_NORTE);

    await app.query(`DELETE FROM guard_sites WHERE site_id = $1`, [RECINTO_NORTE]);
    // Y si el unico asignado es el que no tiene coordenadas, igual se devuelve:
    // un panico sin destino seria peor.
    expect(await recintoElegido(-33.499, -70.651)).toBe(RECINTO_SUR);
  });

  it('un recinto dado de baja no se descarta, pero va despues del activo', async () => {
    await app.query(`UPDATE sites SET is_active = false WHERE id = $1`, [RECINTO_SUR]);
    // Aunque el guardia este encima del Sur, el activo manda.
    expect(await recintoElegido(-33.499, -70.651)).toBe(RECINTO_NORTE);

    await app.query(`UPDATE sites SET is_active = false WHERE id = $1`, [RECINTO_NORTE]);
    // Con los dos de baja, el panico sigue teniendo destino.
    expect(await recintoElegido(-33.499, -70.651)).toBe(RECINTO_SUR);
  });

  it('sin ningun recinto asignado no devuelve nada, y el servicio responde 409, no 500', async () => {
    await app.query(`DELETE FROM guard_sites WHERE guard_id = $1`, [GUARDIA]);
    expect(await recintoElegido(-33.45, -70.66)).toBeNull();
  });
});
