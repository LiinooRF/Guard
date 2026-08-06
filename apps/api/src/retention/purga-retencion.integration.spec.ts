import { Client } from 'pg';

/**
 * La purga contra PostgreSQL DE VERDAD.
 *
 * Es el unico lugar donde se puede comprobar lo que sostiene todo el carril y
 * que ningun mock puede confirmar:
 *
 *   1. voxia_app SIGUE sin poder borrar la evidencia append-only.
 *   2. Y sin embargo la purga borra — porque pasa por funciones SECURITY
 *      DEFINER que corren como el dueño de las tablas.
 *   3. El piso de retencion se aplica en la base, no en el codigo.
 *   4. Las funciones se niegan a correr dentro de una sesion con tenant.
 *   5. La rotacion de empresas avanza: es el bug por el que, con el techo en
 *      500, la empresa 501 no se purgaba nunca.
 *
 * `admin` es la credencial de migraciones (superusuario) y `app` es voxia_app,
 * el mismo rol restringido que usa la API. Igual que
 * tenant-isolation.integration.spec.ts.
 */
const adminUrl = process.env.DATABASE_TEST_URL;
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = adminUrl && appUrl ? describe : describe.skip;

const APPEND_ONLY = ['scan_photos', 'event_photos', 'field_events', 'audit_log'] as const;

/** sha256 de prueba: no colisiona con evidencia real y se limpia al final. */
const SHA_PRUEBA = 'f'.repeat(63) + '9';

describeDatabase('purga por retencion (esquema real)', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await Promise.all([admin.connect(), app.connect()]);
  });

  afterAll(async () => {
    await Promise.all([admin.end(), app.end()]);
  });

  it('voxia_app sigue SIN poder borrar la evidencia append-only', async () => {
    // Si esto deja de fallar, la purga se llevo puesta la propiedad que hace que
    // el libro de novedades sirva como prueba en un juicio laboral.
    for (const tabla of APPEND_ONLY) {
      await expect(app.query(`DELETE FROM "${tabla}" WHERE false`)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('voxia_app no puede escribir la bitacora de purgas', async () => {
    await expect(
      app.query(
        `INSERT INTO retention_purge_runs (tenant_id, dataset, retention_days, cutoff, rows_deleted)
         VALUES (gen_random_uuid(), 'scan_photos', 30, now(), 1)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('voxia_app no puede tocar el cursor del barrido', async () => {
    // Con UPDATE directo, una empresa podria atrasarse la marca a si misma y
    // salirse de la rotacion: dejar de purgar sus datos sin que nadie lo note.
    await expect(
      app.query(`UPDATE retention_tenant_sweeps SET swept_at = now()`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query(
        `INSERT INTO retention_tenant_sweeps (tenant_id) VALUES (gen_random_uuid())`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('las dos tablas nuevas tienen RLS con FORCE y al menos una politica', async () => {
    for (const tabla of ['retention_purge_runs', 'retention_tenant_sweeps']) {
      const { rows } = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policy_count: string;
      }>(
        `SELECT class.relrowsecurity, class.relforcerowsecurity,
                count(policy.policyname)::text AS policy_count
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
         LEFT JOIN pg_policies policy
           ON policy.schemaname = namespace.nspname AND policy.tablename = class.relname
         WHERE namespace.nspname = 'public' AND class.relname = $1
         GROUP BY class.relrowsecurity, class.relforcerowsecurity`,
        [tabla],
      );
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policy_count: expect.not.stringMatching(/^0$/),
      });
    }
  });

  it('el piso de retencion lo aplica la base', async () => {
    // Un override corrupto que diga "1 dia" no puede vaciar la evidencia.
    const fotos = await app.query<{ dias: number }>(
      `SELECT retencion_dias_efectivos('scan_photos', 1) AS dias`,
    );
    expect(fotos.rows[0]?.dias).toBe(30);

    const trazas = await app.query<{ dias: number }>(
      `SELECT retencion_dias_efectivos('patrol_tracks', 1) AS dias`,
    );
    expect(trazas.rows[0]?.dias).toBe(7);

    // Por encima del piso manda la configuracion del tenant.
    const configurado = await app.query<{ dias: number }>(
      `SELECT retencion_dias_efectivos('scan_photos', 365) AS dias`,
    );
    expect(configurado.rows[0]?.dias).toBe(365);
  });

  it('rechaza un conjunto que no es purgable', async () => {
    // field_events y audit_log NO se purgan por antiguedad, y la base lo sabe.
    for (const conjunto of ['field_events', 'audit_log', 'patrols']) {
      await expect(
        app.query(`SELECT retencion_dias_efectivos($1, 30)`, [conjunto]),
      ).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('se niega a correr dentro de una sesion con contexto de tenant', async () => {
    // Es el cerrojo que cierra la purga para CUALQUIER request: un endpoint
    // siempre tiene app.tenant_id seteado.
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', gen_random_uuid()::text, true)`);
      // Cada comprobacion va en su SAVEPOINT. La primera sentencia que falla
      // ABORTA la transaccion entera, asi que sin esto la segunda no devolvia
      // 42501 sino 25P02 (in_failed_sql_transaction): dejaba de medir el
      // cerrojo y pasaba a medir que la transaccion ya estaba rota. Lo cazo CI
      // contra PostgreSQL de verdad; con mocks se veia igual de verde.
      for (const sentencia of [
        `SELECT retencion_dias_efectivos('scan_photos', 30)`,
        `SELECT retencion_marcar_barrido(gen_random_uuid())`,
      ]) {
        await app.query('SAVEPOINT cerrojo');
        await expect(app.query(sentencia)).rejects.toMatchObject({ code: '42501' });
        await app.query('ROLLBACK TO SAVEPOINT cerrojo');
      }
    } finally {
      await app.query('ROLLBACK');
    }

    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', gen_random_uuid()::text, true)`);
      const { rows } = await app.query(`SELECT tenant_id FROM retencion_tenants(100)`);
      // Esta no lanza: devuelve vacio, que es fallar cerrada igual que las
      // politicas RLS.
      expect(rows).toHaveLength(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('sin contexto de tenant lista empresas, y solo identificadores', async () => {
    const { rows, fields } = await app.query(`SELECT * FROM retencion_tenants(5)`);
    expect(fields.map((campo) => campo.name)).toEqual(['tenant_id']);
    // Con la base sembrada hay al menos una; sin sembrar, cero es correcto.
    expect(Array.isArray(rows)).toBe(true);
  });

  /**
   * EL BUG 1, contra la base.
   *
   * El escenario minimo que lo reproduce: pedir UNA sola empresa por pasada. Con
   * el `ORDER BY empresa.id` de antes, las dos pasadas devolvian la misma; con
   * la rotacion, la segunda pasada devuelve la otra.
   */
  it('la rotacion no repite la misma empresa mientras queden sin barrer', async () => {
    const { rows: empresas } = await admin.query<{ id: string }>(
      `SELECT id FROM tenants ORDER BY id LIMIT 2`,
    );
    // Con menos de dos empresas sembradas no hay rotacion que observar.
    if (empresas.length < 2) return;

    const previas = await admin.query<{ tenant_id: string; swept_at: Date }>(
      `SELECT tenant_id, swept_at FROM retention_tenant_sweeps`,
    );

    try {
      // Todas al mismo punto de partida: nadie barrido.
      await admin.query(`DELETE FROM retention_tenant_sweeps`);

      const primera = await app.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM retencion_tenants(1)`,
      );
      const unaEmpresa = primera.rows[0]?.tenant_id;
      expect(unaEmpresa).toBeDefined();

      await app.query(`SELECT retencion_marcar_barrido($1)`, [unaEmpresa]);

      const segunda = await app.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM retencion_tenants(1)`,
      );
      // Antes del arreglo, esto devolvia la MISMA empresa para siempre.
      expect(segunda.rows[0]?.tenant_id).not.toBe(unaEmpresa);
    } finally {
      await admin.query(`DELETE FROM retention_tenant_sweeps`);
      for (const fila of previas.rows) {
        await admin.query(
          `INSERT INTO retention_tenant_sweeps (tenant_id, swept_at) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET swept_at = EXCLUDED.swept_at`,
          [fila.tenant_id, fila.swept_at],
        );
      }
    }
  });

  it('marcar el barrido de una empresa que ya no existe no es un error', async () => {
    // Una pasada dura minutos y el borrado de empresa (#33) puede correr en el
    // medio: la FK abortaria la marca y el barrido registraria un fallo falso.
    await expect(
      app.query(`SELECT retencion_marcar_barrido(gen_random_uuid())`),
    ).resolves.toBeDefined();
  });

  it('purga una traza vencida y deja su fila en la bitacora', async () => {
    const { rows: rondas } = await admin.query<{
      tenant_id: string;
      id: string;
      guard_id: string;
    }>(`SELECT tenant_id, id, guard_id FROM patrols LIMIT 1`);
    const ronda = rondas[0];
    // Sin datos sembrados no hay nada que purgar y el test no aplica.
    if (!ronda) return;

    await admin.query(
      `INSERT INTO patrol_tracks (
         tenant_id, patrol_id, guard_id, recorded_at_device, latitude, longitude, created_at
       ) VALUES ($1, $2, $3, now() - interval '400 days', -33.45, -70.66,
                 now() - interval '400 days')`,
      [ronda.tenant_id, ronda.id, ronda.guard_id],
    );

    try {
      const { rows } = await app.query<{ retencion_purgar_trazas: number }>(
        `SELECT retencion_purgar_trazas($1, 90, 1000)`,
        [ronda.tenant_id],
      );
      expect(Number(rows[0]?.retencion_purgar_trazas)).toBeGreaterThanOrEqual(1);

      const { rows: quedan } = await admin.query(
        `SELECT 1 FROM patrol_tracks
         WHERE tenant_id = $1 AND created_at < now() - interval '100 days'`,
        [ronda.tenant_id],
      );
      expect(quedan).toHaveLength(0);

      const { rows: bitacora } = await admin.query<{ retention_days: number }>(
        `SELECT retention_days FROM retention_purge_runs
         WHERE tenant_id = $1 AND dataset = 'patrol_tracks'
         ORDER BY executed_at DESC LIMIT 1`,
        [ronda.tenant_id],
      );
      expect(bitacora[0]?.retention_days).toBe(90);
    } finally {
      await admin.query(
        `DELETE FROM patrol_tracks WHERE tenant_id = $1 AND created_at < now() - interval '100 days'`,
        [ronda.tenant_id],
      );
      await admin.query(
        `DELETE FROM retention_purge_runs WHERE tenant_id = $1 AND dataset = 'patrol_tracks'`,
        [ronda.tenant_id],
      );
    }
  });

  it('purga una foto de escaneo vencida aunque voxia_app no pueda borrarla', async () => {
    const { rows: escaneos } = await admin.query<{
      tenant_id: string;
      id: string;
      patrol_id: string;
      checkpoint_id: string;
    }>(`SELECT tenant_id, id, patrol_id, checkpoint_id FROM scans LIMIT 1`);
    const escaneo = escaneos[0];
    if (!escaneo) return;

    await admin.query(
      `INSERT INTO scan_photos (
         tenant_id, scan_id, patrol_id, checkpoint_id, storage_path, mime_type,
         size_bytes, sha256, created_at
       ) VALUES ($1, $2, $3, $4, 'purga/prueba.jpg', 'image/jpeg', 4096, $5,
                 now() - interval '400 days')
       ON CONFLICT DO NOTHING`,
      [escaneo.tenant_id, escaneo.id, escaneo.patrol_id, escaneo.checkpoint_id, SHA_PRUEBA],
    );

    try {
      const { rows: vencidas } = await app.query<{
        foto_id: string;
        ruta_relativa: string;
        peso_bytes: string;
      }>(
        `SELECT foto_id, ruta_relativa, peso_bytes
         FROM retencion_fotos_vencidas($1, 'scan_photos', 365, 100, '{}'::uuid[])`,
        [escaneo.tenant_id],
      );

      const nuestra = vencidas.find((fila) => fila.ruta_relativa === 'purga/prueba.jpg');
      expect(nuestra).toBeDefined();

      // EL BUG 2, del lado de la base: pedida de nuevo con la foto en la lista
      // de exclusion, ya no vuelve a salir. Sin esto, el barrido se tropieza con
      // ella en todos los lotes de la pasada.
      const { rows: sinLaNuestra } = await app.query<{ foto_id: string }>(
        `SELECT foto_id
         FROM retencion_fotos_vencidas($1, 'scan_photos', 365, 100, $2::uuid[])`,
        [escaneo.tenant_id, [nuestra!.foto_id]],
      );
      expect(sinLaNuestra.map((fila) => fila.foto_id)).not.toContain(nuestra!.foto_id);

      const { rows: purgadas } = await app.query<{
        filas_borradas: number;
        bytes_liberados: string;
      }>(
        `SELECT filas_borradas, bytes_liberados
         FROM retencion_purgar_fotos($1, 'scan_photos', 365, $2::uuid[])`,
        [escaneo.tenant_id, [nuestra!.foto_id]],
      );
      expect(purgadas[0]?.filas_borradas).toBe(1);
      expect(Number(purgadas[0]?.bytes_liberados)).toBe(4096);

      const { rows: quedan } = await admin.query(`SELECT 1 FROM scan_photos WHERE sha256 = $1`, [
        SHA_PRUEBA,
      ]);
      expect(quedan).toHaveLength(0);
    } finally {
      await admin.query(`DELETE FROM scan_photos WHERE sha256 = $1`, [SHA_PRUEBA]);
      await admin.query(
        `DELETE FROM retention_purge_runs WHERE tenant_id = $1 AND dataset = 'scan_photos'`,
        [escaneo.tenant_id],
      );
    }
  });

  it('no borra una foto que todavia esta dentro de la ventana', async () => {
    const { rows: escaneos } = await admin.query<{
      tenant_id: string;
      id: string;
      patrol_id: string;
      checkpoint_id: string;
    }>(`SELECT tenant_id, id, patrol_id, checkpoint_id FROM scans LIMIT 1`);
    const escaneo = escaneos[0];
    if (!escaneo) return;

    await admin.query(
      `INSERT INTO scan_photos (
         tenant_id, scan_id, patrol_id, checkpoint_id, storage_path, mime_type,
         size_bytes, sha256, created_at
       ) VALUES ($1, $2, $3, $4, 'purga/reciente.jpg', 'image/jpeg', 1024, $5, now())
       ON CONFLICT DO NOTHING`,
      [escaneo.tenant_id, escaneo.id, escaneo.patrol_id, escaneo.checkpoint_id, SHA_PRUEBA],
    );

    try {
      const { rows: foto } = await admin.query<{ id: string }>(
        `SELECT id FROM scan_photos WHERE sha256 = $1`,
        [SHA_PRUEBA],
      );
      if (!foto[0]) return;

      // Se le pide explicitamente que borre ESA foto por id: la funcion tiene que
      // negarse igual, porque revalida la ventana. Sin eso, EXECUTE sobre la
      // funcion seria borrado arbitrario de evidencia.
      const { rows: purgadas } = await app.query<{ filas_borradas: number }>(
        `SELECT filas_borradas
         FROM retencion_purgar_fotos($1, 'scan_photos', 365, $2::uuid[])`,
        [escaneo.tenant_id, [foto[0].id]],
      );
      expect(purgadas[0]?.filas_borradas).toBe(0);

      const { rows: quedan } = await admin.query(`SELECT 1 FROM scan_photos WHERE sha256 = $1`, [
        SHA_PRUEBA,
      ]);
      expect(quedan).toHaveLength(1);
    } finally {
      await admin.query(`DELETE FROM scan_photos WHERE sha256 = $1`, [SHA_PRUEBA]);
    }
  });
});
