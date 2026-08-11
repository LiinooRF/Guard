import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';
import { Client } from 'pg';
import { DataSource, type QueryRunner } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EventsStreamService } from '../events-stream/events-stream.service';
import type { PushService } from '../push/push.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { AlertasRondaService } from './alertas-ronda.service';

/**
 * Benchmark opt-in del detector QUE EXISTE en staging para #222.
 *
 * No propone watermarks ni cambia la arquitectura: mide que cada apertura
 * vuelve a ejecutar el SQL de AlertasRondaService y que la restriccion unica
 * de patrol_alerts evita duplicados. La salida QA222_PERFORMANCE deja
 * dataset, version de PostgreSQL, estado de cache, tiempos y limitaciones. El
 * marcador se escribe solo despues de borrar el fixture y cerrar las sesiones.
 *
 * Requiere una PostgreSQL 17 EFIMERA cuyo nombre contenga 222. El fixture se
 * confirma para que ANALYZE y aperturas sucesivas vean el mismo volumen, pero
 * el finally borra solo sus UUID y comprueba que no quede residuo.
 *
 * Comando exacto (las dos URLs deben apuntar a la misma DB descartable):
 * RUN_PERFORMANCE_TESTS=1 DATABASE_TEST_URL="$QA222_ADMIN_URL" \
 * DATABASE_APP_TEST_URL="$QA222_APP_URL" npm test --workspace @voxia/api -- \
 * --runInBand alertas-ronda.performance.integration.spec.ts
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const adminUrl = process.env.DATABASE_TEST_URL;

function performanceSolicitada(valor: string | undefined): boolean {
  return valor === '1';
}

const describePerformance = performanceSolicitada(process.env.RUN_PERFORMANCE_TESTS)
  ? describe
  : describe.skip;

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const GUARDIA = 'a0000000-0000-4000-8000-000000000002';
const SUPERVISOR = 'a0000000-0000-4000-8000-000000000008';

const PATRULLAS = 1_000;
const ESCANEOS_INICIALES_POR_PATRULLA = 2;
const MUESTRAS_ESTABLES = 25;
const ENTERO_32_MIN = -2_147_483_648;
const ENTERO_32_MAX_EXCLUSIVO = 2_147_483_648;
const CLEANUP_STRATEGY =
  'DELETE acotado por tenant/site/route UUID; cascadas comprobadas contra los 1000 patrol UUID; ' +
  'estructura comprobada por site/route UUID; VACUUM ANALYZE; tabla TEMP eliminada al cerrar ' +
  'la sesion de voxia_app; conexiones admin/app cerradas antes de emitir el marcador.';

type Fase = 'primera' | 'estable' | 'tardia' | 'posterior-tardia';

interface MetricaSql {
  fase: Fase;
  etiqueta: string;
  ms: number;
  filas: number;
}

interface Apertura {
  serviceMs: number;
  transactionMs: number;
  board: Awaited<ReturnType<AlertasRondaService['listar']>>;
}

interface EstadoAlertas {
  total: number;
  distintas: number;
  incompletas: number;
  sospechosas: number;
}

interface NodoPlan {
  nodeType: string;
  relation?: string;
  index?: string;
  actualRows?: number;
  actualLoops?: number;
  rowsRemovedByFilter?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
}

interface ResumenPlan {
  planningMs?: number;
  executionMs?: number;
  tuplesInserted?: number;
  conflictingTuples?: number;
  conflictArbiterIndexes?: string[];
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  nodes: NodoPlan[];
}

interface IdentidadInstancia {
  sameDatabase: true;
  advisoryLockContended: true;
  adminLockReleased: true;
  proof: string;
}

const REGLAS = {
  ...patrolRulesSchema.parse({}),
  patrolStartGraceMin: 10,
  patrolLateGraceMin: 15,
  alertAnomalyScanThreshold: 3,
  alertLookbackDays: 3,
} as unknown as PatrolRules;

const redondear = (valor: number): number => Math.round(valor * 1_000) / 1_000;

function percentil(valores: number[], proporcion: number): number {
  if (!valores.length) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const indice = Math.max(0, Math.ceil(ordenados.length * proporcion) - 1);
  return redondear(ordenados[indice] ?? 0);
}

function resumenTiempos(valores: number[]) {
  return {
    samples: valores.length,
    minMs: redondear(Math.min(...valores)),
    p50Ms: percentil(valores, 0.5),
    p95Ms: percentil(valores, 0.95),
    maxMs: redondear(Math.max(...valores)),
  };
}

function etiquetaSql(sql: string): string {
  if (sql.includes('WITH ronda AS')) return 'deteccion-rondas';
  if (sql.includes('WITH evento AS')) return 'deteccion-eventos';
  if (sql.includes('WITH tomadas AS') && sql.includes('notified_at')) return 'tomar-alertas';
  if (sql.includes('FROM patrol_alerts a') && sql.includes('GROUP BY a.kind')) {
    return 'contar-pendientes';
  }
  if (sql.includes('FROM patrol_alerts a')) return 'listar-alertas';
  if (sql.includes('FROM memberships m') && sql.includes('supervisor_sites')) {
    return 'destinatarios';
  }
  if (sql.includes('SELECT tenant_id, name FROM sites')) return 'recinto';
  return 'otra';
}

function resumirSql(metricas: MetricaSql[], fase: Fase) {
  const porEtiqueta = new Map<string, MetricaSql[]>();
  for (const metrica of metricas.filter((item) => item.fase === fase)) {
    const muestras = porEtiqueta.get(metrica.etiqueta) ?? [];
    muestras.push(metrica);
    porEtiqueta.set(metrica.etiqueta, muestras);
  }

  return [...porEtiqueta.entries()].map(([etiqueta, muestras]) => {
    const tiempos = muestras.map((muestra) => muestra.ms);
    return {
      etiqueta,
      calls: muestras.length,
      returnedRows: muestras.reduce((total, muestra) => total + muestra.filas, 0),
      p50Ms: percentil(tiempos, 0.5),
      p95Ms: percentil(tiempos, 0.95),
      maxMs: redondear(Math.max(...tiempos)),
    };
  });
}

function numero(valor: unknown): number | undefined {
  return typeof valor === 'number' ? valor : undefined;
}

function recolectarNodos(plan: Record<string, unknown>, destino: NodoPlan[]): void {
  destino.push({
    nodeType: String(plan['Node Type'] ?? 'desconocido'),
    relation: typeof plan['Relation Name'] === 'string' ? plan['Relation Name'] : undefined,
    index: typeof plan['Index Name'] === 'string' ? plan['Index Name'] : undefined,
    actualRows: numero(plan['Actual Rows']),
    actualLoops: numero(plan['Actual Loops']),
    rowsRemovedByFilter: numero(plan['Rows Removed by Filter']),
    sharedHitBlocks: numero(plan['Shared Hit Blocks']),
    sharedReadBlocks: numero(plan['Shared Read Blocks']),
  });

  if (!Array.isArray(plan.Plans)) return;
  for (const hijo of plan.Plans) {
    if (hijo && typeof hijo === 'object') {
      recolectarNodos(hijo as Record<string, unknown>, destino);
    }
  }
}

async function explicarDetector(
  runner: QueryRunner,
  sql: string,
  parametros: unknown[],
): Promise<ResumenPlan> {
  await runner.startTransaction();
  try {
    await runner.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true)`,
      [TENANT, SUPERVISOR],
    );
    await runner.query('SAVEPOINT qa222_explain');
    const filas = (await runner.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      parametros,
    )) as Array<{ 'QUERY PLAN': unknown }>;
    await runner.query('ROLLBACK TO SAVEPOINT qa222_explain');
    await runner.query('RELEASE SAVEPOINT qa222_explain');
    await runner.commitTransaction();

    const documento = filas[0]?.['QUERY PLAN'];
    const raizDocumento = Array.isArray(documento) ? documento[0] : undefined;
    if (!raizDocumento || typeof raizDocumento !== 'object') {
      throw new Error('PostgreSQL no devolvio un plan JSON para el detector de rondas');
    }

    const raiz = raizDocumento as Record<string, unknown>;
    const plan = raiz.Plan;
    if (!plan || typeof plan !== 'object') {
      throw new Error('El plan JSON del detector no contiene Plan');
    }

    const planRaiz = plan as Record<string, unknown>;
    const nodes: NodoPlan[] = [];
    recolectarNodos(planRaiz, nodes);
    return {
      planningMs: numero(raiz['Planning Time']),
      executionMs: numero(raiz['Execution Time']),
      tuplesInserted: numero(planRaiz['Tuples Inserted']),
      conflictingTuples: numero(planRaiz['Conflicting Tuples']),
      conflictArbiterIndexes: Array.isArray(planRaiz['Conflict Arbiter Indexes'])
        ? (planRaiz['Conflict Arbiter Indexes'] as unknown[]).map(String)
        : undefined,
      sharedHitBlocks: numero(planRaiz['Shared Hit Blocks']),
      sharedReadBlocks: numero(planRaiz['Shared Read Blocks']),
      nodes,
    };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  }
}

function baseEfimeraDeQa222(nombre: string): boolean {
  const reservada = /release[_-]?gate|staging|production|prod/i.test(nombre);
  const marcada = /222/.test(nombre);
  return marcada && !reservada;
}

/**
 * Un nombre de base igual no demuestra que las URLs lleguen al mismo cluster.
 * El admin toma un advisory lock de sesion aleatorio y la conexion de app debe
 * encontrarlo ocupado. En dos instancias distintas, aun con el mismo dbname,
 * la app lo adquiriria y el benchmark falla antes de VACUUM o de crear filas.
 */
async function demostrarMismaInstanciaYBase(
  admin: Client,
  runner: QueryRunner,
  baseAdmin: string,
  baseApp: string,
): Promise<IdentidadInstancia> {
  if (baseAdmin !== baseApp) {
    throw new Error('DATABASE_TEST_URL y DATABASE_APP_TEST_URL apuntan a bases distintas');
  }

  const claveA = randomInt(ENTERO_32_MIN, ENTERO_32_MAX_EXCLUSIVO);
  const claveB = randomInt(ENTERO_32_MIN, ENTERO_32_MAX_EXCLUSIVO);
  await admin.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [claveA, claveB]);

  let huboContencion = false;
  let errorPrueba: unknown;
  try {
    const intento = (await runner.query(
      `SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired`,
      [claveA, claveB],
    )) as Array<{ acquired: boolean }>;
    const adquirioApp = intento[0]?.acquired;
    if (typeof adquirioApp !== 'boolean') {
      throw new Error('PostgreSQL no devolvio el resultado del advisory lock QA222');
    }

    if (adquirioApp) {
      const liberadoApp = (await runner.query(
        `SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked`,
        [claveA, claveB],
      )) as Array<{ unlocked: boolean }>;
      if (liberadoApp[0]?.unlocked !== true) {
        throw new Error('QA222 no pudo liberar el advisory lock adquirido por voxia_app');
      }
      throw new Error(
        'DATABASE_TEST_URL y DATABASE_APP_TEST_URL usan instancias distintas aunque el nombre de base coincida',
      );
    }

    huboContencion = true;
  } catch (error) {
    errorPrueba = error;
  }

  let errorLiberacionAdmin: unknown;
  try {
    const liberadoAdmin = await admin.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
      [claveA, claveB],
    );
    if (liberadoAdmin.rows[0]?.unlocked !== true) {
      throw new Error('QA222 no pudo liberar el advisory lock adquirido por admin');
    }
  } catch (error) {
    errorLiberacionAdmin = error;
  }

  if (errorLiberacionAdmin) throw errorLiberacionAdmin;
  if (errorPrueba) throw errorPrueba;
  if (!huboContencion) {
    throw new Error('QA222 no pudo demostrar la identidad de la instancia PostgreSQL');
  }

  return {
    sameDatabase: true,
    advisoryLockContended: true,
    adminLockReleased: true,
    proof:
      'admin adquirio y libero su advisory lock de sesion aleatorio; voxia_app no lo adquirio porque lo encontro ocupado',
  };
}

function completarEvidenciaTrasCleanup(
  pendiente: Record<string, unknown> | undefined,
  cleanupVerified: boolean,
): Record<string, unknown> {
  if (!pendiente || !cleanupVerified) {
    throw new Error('QA222 no emite evidencia de exito sin cleanup completo y verificado');
  }

  const dataset = pendiente['dataset'];
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error('La evidencia QA222 no contiene un dataset valido');
  }

  return {
    ...pendiente,
    dataset: {
      ...(dataset as Record<string, unknown>),
      cleanupVerified: true,
      cleanupStrategy: CLEANUP_STRATEGY,
    },
  };
}

describe('guardias deterministas del benchmark QA222', () => {
  it('solo activa el benchmark con el flag exacto', () => {
    expect(
      [undefined, '', '0', 'true', '01', '1'].map((valor) => performanceSolicitada(valor)),
    ).toEqual([false, false, false, false, false, true]);
  });

  it('acepta bases QA222 descartables y rechaza nombres no marcados o reservados', () => {
    expect(
      [
        'qa222_benchmark_760f5d9',
        'qa_222_benchmark',
        'pr-222-local',
        'qa_benchmark',
        'staging_222',
        'production_222',
        'prod-222',
        'release_gate_222',
      ].map((nombre) => baseEfimeraDeQa222(nombre)),
    ).toEqual([true, true, true, false, false, false, false, false]);
  });

  it('no completa evidencia sin cleanup y agrega la estrategia cuando esta verificado', () => {
    expect(() => completarEvidenciaTrasCleanup({ dataset: {} }, false)).toThrow(
      'QA222 no emite evidencia de exito sin cleanup completo y verificado',
    );
    expect(completarEvidenciaTrasCleanup({ dataset: { patrols: 1_000 } }, true)).toEqual({
      dataset: {
        patrols: 1_000,
        cleanupVerified: true,
        cleanupStrategy: CLEANUP_STRATEGY,
      },
    });
  });
});

async function limpiarFixture(
  admin: Client,
  runner: QueryRunner,
  siteId: string,
  routeId: string,
): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query(
      `DELETE FROM patrols
       WHERE tenant_id = $1::uuid AND site_id = $2::uuid`,
      [TENANT, siteId],
    );
    await admin.query(
      `DELETE FROM route_checkpoints
       WHERE tenant_id = $1::uuid AND route_id = $2::uuid`,
      [TENANT, routeId],
    );
    await admin.query(
      `DELETE FROM routes
       WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [TENANT, routeId],
    );
    await admin.query(
      `DELETE FROM checkpoints
       WHERE tenant_id = $1::uuid AND site_id = $2::uuid`,
      [TENANT, siteId],
    );
    await admin.query(
      `DELETE FROM sites
       WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [TENANT, siteId],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }

  await runner.startTransaction();
  try {
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const residuos = (await runner.query(
      `SELECT (
         (SELECT count(*) FROM pg_temp.qa222_perf_patrols fixture
          JOIN patrols p ON p.tenant_id = app_tenant_id() AND p.id = fixture.id) +
         (SELECT count(*) FROM pg_temp.qa222_perf_patrols fixture
          JOIN scans sc ON sc.tenant_id = app_tenant_id() AND sc.patrol_id = fixture.id) +
         (SELECT count(*) FROM pg_temp.qa222_perf_patrols fixture
          JOIN patrol_alerts alerta
            ON alerta.tenant_id = app_tenant_id() AND alerta.patrol_id = fixture.id)
       )::integer AS total`,
    )) as Array<{ total: number }>;
    await runner.rollbackTransaction();
    if (residuos[0]?.total !== 0) {
      throw new Error('El cleanup QA222 dejo rondas, scans o alertas sinteticas');
    }
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  }

  const residuosEstructura = await admin.query<{ total: number }>(
    `SELECT (
       (SELECT count(*) FROM sites WHERE id = $1::uuid) +
       (SELECT count(*) FROM checkpoints WHERE site_id = $1::uuid) +
       (SELECT count(*) FROM routes WHERE site_id = $1::uuid) +
       (SELECT count(*) FROM route_checkpoints WHERE route_id = $2::uuid) +
       (SELECT count(*) FROM patrols WHERE site_id = $1::uuid) +
       (SELECT count(*) FROM patrol_alerts WHERE site_id = $1::uuid)
     )::integer AS total`,
    [siteId, routeId],
  );
  if (residuosEstructura.rows[0]?.total !== 0) {
    throw new Error('El cleanup QA222 dejo estructura sintetica en PostgreSQL');
  }

  await admin.query('VACUUM (ANALYZE) sites, checkpoints, routes, patrols, scans, patrol_alerts');
}

describePerformance('rendimiento actual de alertas-ronda con ~1000 rondas (#222)', () => {
  jest.setTimeout(180_000);

  it('mide reevaluacion, idempotencia y un scan tardio sin cambiar el diseño', async () => {
    if (!appUrl || !adminUrl) {
      throw new Error('El benchmark requiere DATABASE_TEST_URL y DATABASE_APP_TEST_URL');
    }

    const dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    const admin = new Client({ connectionString: adminUrl });
    let runner: QueryRunner | undefined;
    let adminConectado = false;
    let fixtureConfirmado = false;
    let fixtureEliminado = false;
    let cleanupVerified = false;
    let evidenciaPendiente: Record<string, unknown> | undefined;

    const siteId = randomUUID();
    const checkpointA = randomUUID();
    const checkpointB = randomUUID();
    const routeId = randomUUID();
    const lateScanId = randomUUID();

    try {
      await dataSource.initialize();
      await admin.connect();
      adminConectado = true;
      runner = dataSource.createQueryRunner();
      await runner.connect();

      const postgres = await admin.query<{
        database: string;
        role: string;
        server_version: string;
        version_banner: string;
        shared_buffers: string;
        effective_cache_size: string;
        block_size: string;
        started_at: Date;
      }>(`
        SELECT current_database() AS database,
               current_user AS role,
               current_setting('server_version') AS server_version,
               version() AS version_banner,
               current_setting('shared_buffers') AS shared_buffers,
               current_setting('effective_cache_size') AS effective_cache_size,
               current_setting('block_size') AS block_size,
               pg_postmaster_start_time() AS started_at
      `);
      const entorno = postgres.rows[0];
      if (!entorno || !baseEfimeraDeQa222(entorno.database)) {
        throw new Error(
          'QA222 solo confirma fixtures en una base efimera cuyo nombre contenga 222',
        );
      }
      expect(Number(entorno.server_version.split('.')[0])).toBe(17);

      const rolApp = (await runner.query(
        `SELECT current_database() AS database,
                current_user AS role,
                rol.rolsuper,
                rol.rolbypassrls
         FROM pg_roles rol
         WHERE rol.rolname = current_user`,
      )) as Array<{
        database: string;
        role: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>;
      expect(rolApp[0]).toMatchObject({
        database: entorno.database,
        role: 'voxia_app',
        rolsuper: false,
        rolbypassrls: false,
      });

      const identidadInstancia = await demostrarMismaInstanciaYBase(
        admin,
        runner,
        entorno.database,
        rolApp[0]?.database ?? '',
      );

      await admin.query('VACUUM (ANALYZE) patrols, scans, patrol_alerts');

      await runner.startTransaction();
      try {
        await runner.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.user_id', $2, true)`,
          [TENANT, SUPERVISOR],
        );
        const prerequisitos = (await runner.query(
          `SELECT EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = app_tenant_id()
               AND user_id = $1::uuid
               AND role_key = 'GUARDIA'
           ) AS guardia`,
          [GUARDIA],
        )) as Array<{ guardia: boolean }>;
        expect(prerequisitos[0]?.guardia).toBe(true);

        await runner.query(
          `INSERT INTO sites (
             id, tenant_id, branch_name, name, address, latitude, longitude, timezone
           ) VALUES (
             $1::uuid, app_tenant_id(), 'QA 222', 'Recinto temporal benchmark',
             'Fixture efimero sin datos reales', -33.45, -70.66, 'America/Santiago'
           )`,
          [siteId],
        );
        await runner.query(
          `INSERT INTO checkpoints (
             id, tenant_id, site_id, name, suggested_order, kind, requires_photo
           ) VALUES
             ($1::uuid, app_tenant_id(), $3::uuid, 'Punto A', 1, 'normal', false),
             ($2::uuid, app_tenant_id(), $3::uuid, 'Punto B', 2, 'normal', false)`,
          [checkpointA, checkpointB, siteId],
        );
        await runner.query(
          `INSERT INTO routes (
             id, tenant_id, site_id, name, estimated_duration_min, tolerance_min
           ) VALUES (
             $1::uuid, app_tenant_id(), $2::uuid, 'Ruta temporal benchmark', 30, 10
           )`,
          [routeId, siteId],
        );
        await runner.query(
          `INSERT INTO route_checkpoints (
             tenant_id, route_id, checkpoint_id, position, is_closing_point
           ) VALUES
             (app_tenant_id(), $1::uuid, $2::uuid, 1, false),
             (app_tenant_id(), $1::uuid, $3::uuid, 2, true)`,
          [routeId, checkpointA, checkpointB],
        );

        await runner.query(
          `CREATE TEMP TABLE qa222_perf_patrols (
             seq integer PRIMARY KEY,
             id uuid NOT NULL UNIQUE
           ) ON COMMIT PRESERVE ROWS`,
        );
        await runner.query(
          `INSERT INTO pg_temp.qa222_perf_patrols (seq, id)
           SELECT serie, gen_random_uuid()
           FROM generate_series(1, $1::integer) AS serie`,
          [PATRULLAS],
        );
        await runner.query(
          `INSERT INTO patrols (
             id, tenant_id, site_id, route_id, guard_id, status,
             scheduled_start_at, scheduled_end_at, started_at, closed_at,
             expected_checkpoint_ids, compliance_pct
           )
           SELECT
             fixture.id,
             app_tenant_id(),
             $1::uuid,
             $2::uuid,
             $3::uuid,
             'incompleta',
             now() - interval '24 hours' + fixture.seq * interval '1 second',
             now() - interval '23 hours 30 minutes' + fixture.seq * interval '1 second',
             now() - interval '23 hours 59 minutes' + fixture.seq * interval '1 second',
             now() - interval '23 hours 31 minutes' + fixture.seq * interval '1 second',
             $4::jsonb,
             50
           FROM pg_temp.qa222_perf_patrols fixture`,
          [siteId, routeId, GUARDIA, JSON.stringify([checkpointA, checkpointB])],
        );
        await runner.query(
          `INSERT INTO scans (
             id, tenant_id, patrol_id, guard_id, checkpoint_id, method, client_scan_id,
             scanned_at_device, scanned_at_server, latitude, longitude,
             accuracy_m, anomalies
           )
           SELECT
             gen_random_uuid(),
             app_tenant_id(),
             fixture.id,
             $3::uuid,
             CASE WHEN punto.n = 1 THEN $1::uuid ELSE $2::uuid END,
             'qr',
             gen_random_uuid(),
             now() - interval '23 hours 58 minutes'
               + fixture.seq * interval '1 second'
               + punto.n * interval '1 minute',
             now() - interval '23 hours 58 minutes'
               + fixture.seq * interval '1 second'
               + punto.n * interval '1 minute',
             -33.45,
             -70.66,
             5,
             '["sin_fix_gps"]'::jsonb
           FROM pg_temp.qa222_perf_patrols fixture
           CROSS JOIN generate_series(1, $4::integer) AS punto(n)`,
          [checkpointA, checkpointB, GUARDIA, ESCANEOS_INICIALES_POR_PATRULLA],
        );
        await runner.commitTransaction();
        fixtureConfirmado = true;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      }

      await admin.query('ANALYZE sites, patrols, scans, patrol_alerts');

      await runner.startTransaction();
      const volumen = await (async () => {
        try {
          await runner!.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
          const filas = (await runner!.query(
            `SELECT count(DISTINCT p.id)::integer AS patrols,
                    count(sc.id)::integer AS scans,
                    count(sc.id) FILTER (
                      WHERE jsonb_array_length(sc.anomalies) > 0
                    )::integer AS marked_scans
             FROM pg_temp.qa222_perf_patrols fixture
             JOIN patrols p ON p.tenant_id = app_tenant_id() AND p.id = fixture.id
             LEFT JOIN scans sc
               ON sc.tenant_id = p.tenant_id AND sc.patrol_id = p.id`,
          )) as Array<{ patrols: number; scans: number; marked_scans: number }>;
          await runner!.commitTransaction();
          return filas[0];
        } catch (error) {
          if (runner!.isTransactionActive) await runner!.rollbackTransaction();
          throw error;
        }
      })();
      expect(volumen).toEqual({
        patrols: PATRULLAS,
        scans: PATRULLAS * ESCANEOS_INICIALES_POR_PATRULLA,
        marked_scans: PATRULLAS * ESCANEOS_INICIALES_POR_PATRULLA,
      });

      const metricasSql: MetricaSql[] = [];
      let fase: Fase = 'primera';
      let detector:
        | {
            sql: string;
            parametros: unknown[];
          }
        | undefined;

      const ejecutarSql = async (sql: string, parametros: unknown[] = []) => {
        const etiqueta = etiquetaSql(sql);
        if (etiqueta === 'deteccion-rondas' && !detector) {
          detector = { sql, parametros: [...parametros] };
        }
        const inicio = performance.now();
        const resultado = (await runner!.query(sql, parametros)) as unknown;
        metricasSql.push({
          fase,
          etiqueta,
          ms: redondear(performance.now() - inicio),
          filas: Array.isArray(resultado) ? resultado.length : 0,
        });
        return resultado;
      };

      const service = new AlertasRondaService(
        { manager: { query: ejecutarSql } } as unknown as TenantContextService,
        { effective: async () => REGLAS } as unknown as RulesService,
        { ensureAssignedSite: async () => undefined } as unknown as SupervisorService,
        { send: async () => ({ enqueued: 0 }) } as unknown as PushService,
        { publish: () => undefined } as unknown as EventsStreamService,
      );

      const abrir = async (faseActual: Fase): Promise<Apertura> => {
        fase = faseActual;
        const inicioTransaccion = performance.now();
        await runner!.startTransaction();
        try {
          await runner!.query(
            `SELECT set_config('app.tenant_id', $1, true),
                    set_config('app.user_id', $2, true)`,
            [TENANT, SUPERVISOR],
          );
          const inicioServicio = performance.now();
          const board = await service.listar(siteId, SUPERVISOR, true);
          const serviceMs = redondear(performance.now() - inicioServicio);
          await runner!.commitTransaction();
          return {
            serviceMs,
            transactionMs: redondear(performance.now() - inicioTransaccion),
            board,
          };
        } catch (error) {
          if (runner!.isTransactionActive) await runner!.rollbackTransaction();
          throw error;
        }
      };

      const estadoAlertas = async (): Promise<EstadoAlertas> => {
        await runner!.startTransaction();
        try {
          await runner!.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
          const filas = (await runner!.query(
            `SELECT count(*)::integer AS total,
                    count(DISTINCT (alerta.patrol_id, alerta.kind))::integer AS distintas,
                    count(*) FILTER (WHERE alerta.kind = 'incompleta')::integer AS incompletas,
                    count(*) FILTER (
                      WHERE alerta.kind = 'escaneos_sospechosos'
                    )::integer AS sospechosas
             FROM patrol_alerts alerta
             JOIN pg_temp.qa222_perf_patrols fixture ON fixture.id = alerta.patrol_id
             WHERE alerta.tenant_id = app_tenant_id()
               AND alerta.site_id = $1::uuid`,
            [siteId],
          )) as EstadoAlertas[];
          await runner!.commitTransaction();
          return filas[0] ?? { total: 0, distintas: 0, incompletas: 0, sospechosas: 0 };
        } catch (error) {
          if (runner!.isTransactionActive) await runner!.rollbackTransaction();
          throw error;
        }
      };

      const primera = await abrir('primera');
      expect(primera.board.detectedNow).toBe(PATRULLAS);
      expect(primera.board.pendingTotal).toBe(PATRULLAS);
      expect(primera.board.alerts).toHaveLength(200);
      const despuesPrimera = await estadoAlertas();
      expect(despuesPrimera).toEqual({
        total: PATRULLAS,
        distintas: PATRULLAS,
        incompletas: PATRULLAS,
        sospechosas: 0,
      });

      const estables: Apertura[] = [];
      for (let muestra = 0; muestra < MUESTRAS_ESTABLES; muestra += 1) {
        estables.push(await abrir('estable'));
      }
      const segunda = estables[0];
      expect(segunda?.board.detectedNow).toBe(0);
      expect(segunda?.board.pendingTotal).toBe(PATRULLAS);
      const despuesSegunda = await estadoAlertas();
      expect(despuesSegunda).toEqual(despuesPrimera);
      const despuesEstables = await estadoAlertas();
      expect(despuesEstables).toEqual(despuesPrimera);

      const detectorEstable = metricasSql.filter(
        (metrica) => metrica.fase === 'estable' && metrica.etiqueta === 'deteccion-rondas',
      );
      expect(detectorEstable).toHaveLength(MUESTRAS_ESTABLES);
      expect(detectorEstable.every((metrica) => metrica.filas === 0)).toBe(true);

      if (!detector) throw new Error('El servicio no ejecuto su detector de rondas');
      const plan = await explicarDetector(runner, detector.sql, detector.parametros);
      expect(plan.tuplesInserted).toBe(0);
      expect(plan.conflictingTuples).toBe(PATRULLAS);

      await runner.startTransaction();
      try {
        await runner.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.user_id', $2, true)`,
          [TENANT, SUPERVISOR],
        );
        const patrulla = (await runner.query(
          `SELECT id FROM pg_temp.qa222_perf_patrols WHERE seq = 1`,
        )) as Array<{ id: string }>;
        const patrolId = patrulla[0]?.id;
        if (!patrolId) throw new Error('No existe la ronda elegida para el scan tardio');

        await runner.query(
          `INSERT INTO scans (
             id, tenant_id, patrol_id, guard_id, checkpoint_id, method, client_scan_id,
             scanned_at_device, scanned_at_server, latitude, longitude,
             accuracy_m, anomalies
           ) VALUES (
             $1::uuid, app_tenant_id(), $2::uuid, $3::uuid, $4::uuid, 'qr', $5::uuid,
             now() - interval '24 hours', now(), -33.45, -70.66, 5,
             '["reloj_desfasado"]'::jsonb
           )`,
          [lateScanId, patrolId, GUARDIA, checkpointA, randomUUID()],
        );
        await runner.commitTransaction();
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      }

      const tardia = await abrir('tardia');
      expect(tardia.board.detectedNow).toBe(1);
      expect(tardia.board.pendingTotal).toBe(PATRULLAS + 1);
      expect(
        tardia.board.alerts.some(
          (alerta) =>
            alerta.kind === 'escaneos_sospechosos' &&
            alerta.detail['markedScans'] === ESCANEOS_INICIALES_POR_PATRULLA + 1,
        ),
      ).toBe(true);
      const despuesTardia = await estadoAlertas();
      expect(despuesTardia).toEqual({
        total: PATRULLAS + 1,
        distintas: PATRULLAS + 1,
        incompletas: PATRULLAS,
        sospechosas: 1,
      });

      const posteriorTardia = await abrir('posterior-tardia');
      expect(posteriorTardia.board.detectedNow).toBe(0);
      expect(await estadoAlertas()).toEqual(despuesTardia);

      evidenciaPendiente = {
        issue: 222,
        implementationUnderTest: {
          design: 'SQL actual de AlertasRondaService; sin watermarks ni cambios de produccion',
          stableBehavior:
            'reejecuta el detector completo y ON CONFLICT evita alertas duplicadas',
          durationSloMs: null,
          durationSloReason: 'La issue no define un SLO; estos tiempos son baseline local.',
        },
        runtime: {
          node: process.version,
          postgres: {
            database: entorno.database,
            adminRole: entorno.role,
            appRole: rolApp[0]?.role,
            serverVersion: entorno.server_version,
            versionBanner: entorno.version_banner,
            sharedBuffers: entorno.shared_buffers,
            effectiveCacheSize: entorno.effective_cache_size,
            blockSize: entorno.block_size,
            postmasterStartedAt: entorno.started_at.toISOString(),
          },
          databaseIdentity: identidadInstancia,
        },
        dataset: {
          tenants: 1,
          sites: 1,
          routes: 1,
          checkpoints: 2,
          patrols: volumen?.patrols,
          patrolStatus: 'incompleta',
          compliancePct: 50,
          scansBeforeLate: volumen?.scans,
          markedScansBeforeLate: volumen?.marked_scans,
          lateScans: 1,
          lookbackDays: 3,
          committedFixture: true,
        },
        cache: {
          forcedCold: false,
          description:
            'No se vaciaron shared_buffers ni page cache. Primera apertura tras fixture confirmado y ANALYZE; reaperturas con cache naturalmente calida.',
          explainSharedHitBlocks: plan.sharedHitBlocks,
          explainSharedReadBlocks: plan.sharedReadBlocks,
        },
        timings: {
          firstOpen: {
            serviceMs: primera.serviceMs,
            transactionMs: primera.transactionMs,
          },
          stableReopens: {
            service: resumenTiempos(estables.map((apertura) => apertura.serviceMs)),
            transaction: resumenTiempos(estables.map((apertura) => apertura.transactionMs)),
          },
          lateScanOpen: {
            serviceMs: tardia.serviceMs,
            transactionMs: tardia.transactionMs,
          },
          postLateStableOpen: {
            serviceMs: posteriorTardia.serviceMs,
            transactionMs: posteriorTardia.transactionMs,
          },
        },
        behavior: {
          alertsAfterFirstOpen: despuesPrimera,
          alertsAfterSecondOpen: despuesSegunda,
          alertsAfterStableSamples: despuesEstables,
          alertsAfterLateScan: despuesTardia,
          stableDetectorInvocations: detectorEstable.length,
          stableDetectorReturnedRows: detectorEstable.reduce(
            (total, metrica) => total + metrica.filas,
            0,
          ),
          explainCurrentDetector: plan,
        },
        sql: {
          firstOpen: resumirSql(metricasSql, 'primera'),
          stableReopens: resumirSql(metricasSql, 'estable'),
          lateScanOpen: resumirSql(metricasSql, 'tardia'),
          postLateStableOpen: resumirSql(metricasSql, 'posterior-tardia'),
        },
        limitations: [
          'Baseline local; no constituye SLO ni prueba capacidad productiva.',
          'Una conexion y un recinto uniforme; no mide concurrencia ni mezcla de tenants.',
          'No se forzo cache fria: migraciones, seed, fixture y ANALYZE pueden calentar paginas.',
          'Push y stream estan sustituidos; se mide servicio y PostgreSQL, no entrega externa.',
          'El dataset concentra rondas dentro del lookback y no representa distribucion historica.',
        ],
      };
    } finally {
      try {
        if (runner?.isTransactionActive) await runner.rollbackTransaction();
      } finally {
        try {
          if (fixtureConfirmado && runner) {
            await limpiarFixture(admin, runner, siteId, routeId);
            fixtureEliminado = true;
          }
        } finally {
          try {
            if (runner && !runner.isReleased) await runner.release();
          } finally {
            try {
              if (dataSource.isInitialized) await dataSource.destroy();
            } finally {
              if (adminConectado) await admin.end();
            }
          }
        }
      }
      cleanupVerified = fixtureConfirmado && fixtureEliminado;
    }

    const evidencia = completarEvidenciaTrasCleanup(evidenciaPendiente, cleanupVerified);
    process.stdout.write(`\nQA222_PERFORMANCE ${JSON.stringify(evidencia)}\n`);
  });
});
