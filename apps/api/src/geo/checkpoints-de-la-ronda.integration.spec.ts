import { Client } from 'pg';

import { SQL_PUNTOS_DE_LA_RONDA } from './geo.service';

/**
 * El trazado de la ronda patron sobre el mapa, con datos de verdad.
 *
 * La consulta que alimenta la superposicion se probaba solo con mocks, y un
 * mock devuelve lo que el autor cree: no ve un nombre de columna equivocado ni
 * un JOIN que pierde filas. Aca se siembra una ruta real de tres puntos —uno
 * escaneado, uno critico, uno sin coordenadas— y se comprueba lo que el mapa
 * necesita: el ORDEN de la ruta, cuales estan cumplidos y cuales son criticos.
 *
 * Todo dentro de una transaccion que termina en ROLLBACK.
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

const TENANT = '4a000000-0000-4000-8000-000000000001';
const GUARDIA = '4a000000-0000-4000-8000-000000000002';
const RECINTO = '4a000000-0000-4000-8000-000000000003';
const RUTA = '4a000000-0000-4000-8000-000000000004';
const RONDA = '4a000000-0000-4000-8000-000000000005';
const PUNTO_1 = '4a000000-0000-4000-8000-000000000011';
const PUNTO_2 = '4a000000-0000-4000-8000-000000000012';
const PUNTO_3 = '4a000000-0000-4000-8000-000000000013';

interface FilaPunto {
  id: string;
  name: string;
  position: number;
  latitude: string | null;
  longitude: string | null;
  kind: string | null;
  scanned: boolean;
}

describeDatabase('puntos de la ronda para el mapa', () => {
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
       VALUES ($1, 'mapa-e2e', 'Seguridad Mapa SpA', 'Seguridad Mapa')`,
      [TENANT],
    );
    await app.query(
      `INSERT INTO users (id, username, password_hash, given_name, family_name)
       VALUES ($1, 'guardia.mapa.e2e', 'no-usada', 'Guardia', 'Del Mapa')`,
      [GUARDIA],
    );
    await app.query(
      `INSERT INTO memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'GUARDIA')`,
      [TENANT, GUARDIA],
    );
    await app.query(
      `INSERT INTO sites (id, tenant_id, branch_name, name, address)
       VALUES ($1, $2, 'Central', 'Recinto Central', 'Av. Siempre Viva 742')`,
      [RECINTO, TENANT],
    );
    await app.query(
      `INSERT INTO routes (id, tenant_id, site_id, name, estimated_duration_min)
       VALUES ($1, $2, $3, 'Ronda nocturna', 45)`,
      [RUTA, TENANT, RECINTO],
    );
    // El tercero va SIN coordenadas a proposito: el mapa tiene que poder
    // dibujar la linea con los que si las tienen y no plantarse.
    await app.query(
      `INSERT INTO checkpoints (id, tenant_id, site_id, name, kind, latitude, longitude)
       VALUES ($1, $4, $5, 'Acceso Principal', 'acceso_critico', -33.45, -70.66),
              ($2, $4, $5, 'Bodega', 'normal', -33.451, -70.661),
              ($3, $4, $5, 'Perimetro Sur', 'normal', NULL, NULL)`,
      [PUNTO_1, PUNTO_2, PUNTO_3, TENANT, RECINTO],
    );
    // Se insertan DESORDENADOS: lo que ordena es `position`, no el orden fisico.
    await app.query(
      `INSERT INTO route_checkpoints (tenant_id, route_id, checkpoint_id, position)
       VALUES ($1, $2, $5, 3), ($1, $2, $3, 1), ($1, $2, $4, 2)`,
      [TENANT, RUTA, PUNTO_1, PUNTO_2, PUNTO_3],
    );
    await app.query(
      `INSERT INTO patrols (id, tenant_id, site_id, route_id, guard_id,
                            scheduled_start_at, scheduled_end_at, expected_checkpoint_ids)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 hours', now() - interval '1 hour', $6)`,
      [RONDA, TENANT, RECINTO, RUTA, GUARDIA, JSON.stringify([PUNTO_1, PUNTO_2, PUNTO_3])],
    );
    await app.query(
      `INSERT INTO scans (tenant_id, patrol_id, checkpoint_id, method, client_scan_id)
       VALUES ($1, $2, $3, 'nfc', '4a000000-0000-4000-8000-0000000000aa')`,
      [TENANT, RONDA, PUNTO_1],
    );
  });

  afterEach(async () => {
    await app.query('ROLLBACK');
  });

  async function puntos(): Promise<FilaPunto[]> {
    const { rows } = await app.query<FilaPunto>(SQL_PUNTOS_DE_LA_RONDA, [RONDA]);
    return rows;
  }

  it('devuelve los tres puntos en el ORDEN de la ruta, no en el de la tabla', async () => {
    const filas = await puntos();
    expect(filas.map((f) => f.name)).toEqual(['Acceso Principal', 'Bodega', 'Perimetro Sur']);
    expect(filas.map((f) => f.position)).toEqual([1, 2, 3]);
  });

  it('marca cumplido solo el punto que de verdad se escaneo en ESTA ronda', async () => {
    const filas = await puntos();
    expect(filas.map((f) => f.scanned)).toEqual([true, false, false]);
  });

  it('distingue el acceso critico, que en el mapa se dibuja distinto', async () => {
    const filas = await puntos();
    expect(filas.map((f) => f.kind)).toEqual(['acceso_critico', 'normal', 'normal']);
  });

  it('el punto sin coordenadas viene igual, con latitud y longitud nulas', async () => {
    const filas = await puntos();
    expect(filas[2]).toMatchObject({ name: 'Perimetro Sur', latitude: null, longitude: null });
    expect(Number(filas[0]!.latitude)).toBeCloseTo(-33.45, 5);
  });

  it('un escaneo de OTRA ronda del mismo punto NO cuenta como cumplido', async () => {
    // Es la diferencia entre "este guardia paso hoy" y "alguien paso alguna vez
    // por aca": el EXISTS filtra por patrol_id y esto lo comprueba.
    const otraRonda = '4a000000-0000-4000-8000-000000000006';
    await app.query(`DELETE FROM scans WHERE patrol_id = $1`, [RONDA]);
    await app.query(
      `INSERT INTO patrols (id, tenant_id, site_id, route_id, guard_id,
                            scheduled_start_at, scheduled_end_at, expected_checkpoint_ids)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 days', now() - interval '47 hours', $6)`,
      [otraRonda, TENANT, RECINTO, RUTA, GUARDIA, JSON.stringify([PUNTO_1])],
    );
    await app.query(
      `INSERT INTO scans (tenant_id, patrol_id, checkpoint_id, method, client_scan_id)
       VALUES ($1, $2, $3, 'nfc', '4a000000-0000-4000-8000-0000000000bb')`,
      [TENANT, otraRonda, PUNTO_1],
    );

    const filas = await puntos();
    expect(filas.map((f) => f.scanned)).toEqual([false, false, false]);
  });
});
