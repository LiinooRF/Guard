import { Injectable } from '@nestjs/common';
import type { Role } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { FILTRO_RECINTOS } from './stats-site-scope';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import type { ChartQueryDto, EvolutionQueryDto, Granularidad, TopQueryDto } from './dto/chart-query.dto';
import {
  MAX_DIAS_ESCANEOS,
  MAX_DIAS_RANKING,
  MAX_DIAS_SERIE,
  resolverRango,
  type RangoDias,
} from './stats-range';

/** Quien pregunta. El rol define permisos; el SUPERVISOR ademas trae alcance. */
export interface ChartScope {
  readonly userId: string;
  readonly role: Role;
}

const TRUNCADO: Record<Granularidad, string> = {
  dia: 'day',
  semana: 'week',
  mes: 'month',
};

/**
 * Filtro de recintos visibles. Se aplica sobre el alias `s` de `sites`.
 *
 * RLS ya encierra la consulta en el tenant; esto es la capa de ENCIMA: el
 * SUPERVISOR solo ve los recintos que tiene asignados, y eso no se deduce de su
 * rol —el rol solo dice que la restriccion existe—, hay que cruzarlo contra
 * `supervisor_sites` en cada consulta.
 *
 * El `tenant_id` NUNCA viaja como parametro desde el cliente: lo pone el
 * interceptor con `set_config('app.tenant_id', ..., true)` y lo aplica la
 * politica RLS. Un `tenant_id` de query string seria una IDOR con nombre nuevo.
 */

/**
 * Solo las rondas ya terminadas dicen algo del cumplimiento. Una ronda
 * `pendiente` o `en_curso` tiene puntos sin escanear porque todavia no le toca,
 * no porque el guardia los haya saltado: meterlas en "puntos mas omitidos" o en
 * el ranking inventaria un incumplimiento que no ocurrio.
 */
const RONDAS_CERRADAS = `('completada', 'incompleta', 'vencida')`;

interface FilaRecinto {
  site_id: string;
  site_name: string;
  branch_name: string;
  rondas: string;
  completadas: string;
  incompletas: string;
  vencidas: string;
  abiertas: string;
  con_cumplimiento: string;
  cumplimiento: string | null;
}

interface FilaSerie {
  bucket: Date;
  rondas: string;
  completadas: string;
  recintos: string;
  cumplimiento: string | null;
}

interface FilaPunto {
  checkpoint_id: string;
  checkpoint_name: string;
  kind: string;
  site_name: string;
  branch_name: string;
  esperados: string;
  omitidos: string;
  pct_omision: string;
}

interface FilaGuardia {
  guard_id: string;
  guard_name: string;
  rondas: string;
  con_cumplimiento: string;
  cumplimiento: string | null;
  bajo_umbral: string;
}

/**
 * Consultas agregadas que alimentan las graficas de informes (#89).
 *
 * Todo se agrega EN SQL. Traer las rondas al navegador para promediarlas ahi no
 * escala y ademas entrega al cliente datos que no necesita para dibujar una
 * barra.
 *
 * Las dos series por dia se leen del cubo `patrol_daily_stats`; las dos
 * consultas que dependen del umbral vigente o de `scans` se agregan en vivo.
 * Ver la migracion 1725289200000 para el porque del cubo y de cada indice.
 */
@Injectable()
export class StatsChartsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly supervisor: SupervisorService,
  ) {}

  /**
   * Parametros comunes. `supervisorId` va con valor SOLO si el rol es
   * SUPERVISOR: para ADMIN queda NULL y el filtro se apaga solo.
   *
   * Si un SUPERVISOR pide explicitamente un recinto que no tiene asignado,
   * responde 403 y no una grafica vacia — una grafica vacia se lee como "aqui
   * no pasa nada", que es peor que un error. La comprobacion se reusa de
   * SupervisorService: duplicar un control de acceso es como se terminan
   * teniendo dos, y uno desactualizado.
   */
  private async parametros(scope: ChartScope, query: ChartQueryDto, rango: RangoDias) {
    const esSupervisor = scope.role === 'SUPERVISOR';
    if (esSupervisor && query.siteId) {
      await this.supervisor.ensureAssignedSite(query.siteId, scope.userId);
    }
    return [
      rango.desde,
      rango.hasta,
      esSupervisor ? scope.userId : null,
      query.siteId ?? null,
      query.branchName ?? null,
    ];
  }

  /**
   * Deja materializados los cubos de la ventana pedida antes de leerla.
   *
   * Un dia se recalcula si (a) todavia no existe —historico anterior a la
   * migracion, o recinto nuevo— o (b) es hoy o posterior en la zona del
   * recinto, porque sigue recibiendo rondas. Todo lo anterior a hoy ya esta
   * congelado por el trigger de `patrols`, asi que en regimen esto recalcula un
   * dia por recinto y no toca `patrols` para el resto de la ventana.
   *
   * Se recalcula por recinto en UNA sentencia acotada entre el primer y el
   * ultimo dia pendiente, no dia por dia: la primera lectura de un tenant con
   * dos años de historia son 40 sentencias, no 29.000 llamadas.
   *
   * Corre dentro de la transaccion del request, con el `app.tenant_id` del
   * usuario puesto: no hay conexion privilegiada en ninguna parte y la politica
   * RLS de `patrol_daily_stats` valida cada fila escrita.
   */
  private async asegurarCubos(parametros: unknown[]) {
    await this.tenantContext.manager.query(
      `
        WITH ventana AS (
          SELECT s.id AS site_id, s.timezone, g.dia::date AS dia
          FROM sites s
          CROSS JOIN LATERAL generate_series(
            $1::date::timestamp, $2::date::timestamp, INTERVAL '1 day'
          ) AS g(dia)
          WHERE TRUE${FILTRO_RECINTOS}
        ),
        pendientes AS (
          SELECT v.site_id, min(v.dia) AS desde, max(v.dia) AS hasta
          FROM ventana v
          WHERE v.dia >= (now() AT TIME ZONE v.timezone)::date
             OR NOT EXISTS (
                  SELECT 1 FROM patrol_daily_stats r
                  WHERE r.site_id = v.site_id AND r.service_day = v.dia)
          GROUP BY v.site_id
        )
        SELECT count(*)::int AS recintos
        FROM pendientes p,
             LATERAL app_stats_recompute_range(app_tenant_id(), p.site_id, p.desde, p.hasta) AS r
      `,
      parametros,
    );
  }

  /**
   * Cumplimiento por recinto en el periodo. Es la grafica de barras con la que
   * el admin abre el panel, y por eso ordena de PEOR a mejor: se entra a buscar
   * el problema, no a felicitarse.
   *
   * El promedio se reconstruye ponderado (`sum(suma)/sum(conteo)`), nunca como
   * promedio de promedios diarios: un dia con una ronda pesaria igual que un
   * dia con doce.
   */
  async complianceBySite(scope: ChartScope, query: ChartQueryDto) {
    const rango = resolverRango(query.from, query.to, MAX_DIAS_SERIE);
    const parametros = await this.parametros(scope, query, rango);
    await this.asegurarCubos(parametros);
    const reglas = await this.rules.effective();

    const filas = await this.tenantContext.manager.query<FilaRecinto[]>(
      `
        SELECT s.id AS site_id,
               s.name AS site_name,
               s.branch_name,
               sum(r.patrols_total)::int AS rondas,
               sum(r.patrols_completed)::int AS completadas,
               sum(r.patrols_incomplete)::int AS incompletas,
               sum(r.patrols_expired)::int AS vencidas,
               sum(r.patrols_open)::int AS abiertas,
               sum(r.compliance_count)::int AS con_cumplimiento,
               CASE WHEN sum(r.compliance_count) > 0
                    THEN round(sum(r.compliance_sum) / sum(r.compliance_count), 1)
               END AS cumplimiento
        FROM patrol_daily_stats r
        JOIN sites s ON s.tenant_id = r.tenant_id AND s.id = r.site_id
        WHERE r.service_day >= $1::date
          AND r.service_day <= $2::date${FILTRO_RECINTOS}
        GROUP BY s.id, s.name, s.branch_name
        ORDER BY cumplimiento NULLS LAST, s.name
      `,
      parametros,
    );

    return {
      range: rango,
      threshold: reglas.complianceThreshold,
      sites: filas.map((f) => ({
        siteId: f.site_id,
        siteName: f.site_name,
        branchName: f.branch_name,
        patrols: Number(f.rondas),
        completed: Number(f.completadas),
        incomplete: Number(f.incompletas),
        expired: Number(f.vencidas),
        open: Number(f.abiertas),
        ratedPatrols: Number(f.con_cumplimiento),
        compliancePct: f.cumplimiento === null ? null : Number(f.cumplimiento),
        belowThreshold:
          f.cumplimiento !== null && Number(f.cumplimiento) < reglas.complianceThreshold,
      })),
    };
  }

  /**
   * Evolucion en el tiempo. Los cubos ya vienen agrupados por dia LOCAL del
   * recinto, asi que semana y mes salen de truncar una `date` — sin volver a
   * tocar zonas horarias y sin que un cambio de horario mueva un punto de la
   * serie. Ese es medio motivo de que el cubo exista.
   */
  async evolution(scope: ChartScope, query: EvolutionQueryDto) {
    const rango = resolverRango(query.from, query.to, MAX_DIAS_SERIE);
    const parametros = await this.parametros(scope, query, rango);
    await this.asegurarCubos(parametros);
    const granularidad: Granularidad = query.granularity ?? 'dia';
    const reglas = await this.rules.effective();

    const filas = await this.tenantContext.manager.query<FilaSerie[]>(
      `
        SELECT date_trunc($6::text, r.service_day::timestamp)::date AS bucket,
               sum(r.patrols_total)::int AS rondas,
               sum(r.patrols_completed)::int AS completadas,
               count(DISTINCT r.site_id)::int AS recintos,
               CASE WHEN sum(r.compliance_count) > 0
                    THEN round(sum(r.compliance_sum) / sum(r.compliance_count), 1)
               END AS cumplimiento
        FROM patrol_daily_stats r
        JOIN sites s ON s.tenant_id = r.tenant_id AND s.id = r.site_id
        WHERE r.service_day >= $1::date
          AND r.service_day <= $2::date${FILTRO_RECINTOS}
        GROUP BY bucket
        ORDER BY bucket
      `,
      [...parametros, TRUNCADO[granularidad]],
    );

    return {
      range: rango,
      granularity: granularidad,
      threshold: reglas.complianceThreshold,
      points: filas.map((f) => ({
        bucket: f.bucket,
        patrols: Number(f.rondas),
        completed: Number(f.completadas),
        sites: Number(f.recintos),
        compliancePct: f.cumplimiento === null ? null : Number(f.cumplimiento),
      })),
    };
  }

  /**
   * Puntos mas omitidos. Esta es la unica grafica que baja a `scans`, la tabla
   * mas grande del producto, y por eso tiene el tope de rango mas corto.
   *
   * Se expande `expected_checkpoint_ids` de cada ronda cerrada y se pregunta si
   * hubo escaneo. El `EXISTS` —y no un LEFT JOIN— evita que una ronda con el
   * mismo punto escaneado dos veces (pasa: el guardia repite el gesto) cuente
   * doble, y se resuelve dentro de `scans_stats_punto_idx` sin visitar la
   * tabla.
   *
   * El corte del periodo es por instante contra la zona del recinto, con la
   * suma del dia aplicada ANTES de convertir. Una ronda nocturna del ultimo dia
   * del rango que empieza pasada la medianoche puede quedar fuera; para "que
   * punto se saltan siempre" ese margen no cambia la conclusion, y el informe
   * por ronda si es exacto.
   */
  async missedCheckpoints(scope: ChartScope, query: TopQueryDto) {
    const rango = resolverRango(query.from, query.to, MAX_DIAS_ESCANEOS);
    const parametros = await this.parametros(scope, query, rango);

    const filas = await this.tenantContext.manager.query<FilaPunto[]>(
      `
        WITH esperado AS (
          SELECT p.tenant_id,
                 p.site_id,
                 punto.checkpoint_id,
                 EXISTS (
                   SELECT 1 FROM scans sc
                   WHERE sc.tenant_id = p.tenant_id
                     AND sc.patrol_id = p.id
                     AND sc.checkpoint_id = punto.checkpoint_id
                 ) AS escaneado
          FROM patrols p
          JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
          CROSS JOIN LATERAL (
            SELECT (valor.value)::uuid AS checkpoint_id
            FROM jsonb_array_elements_text(p.expected_checkpoint_ids) AS valor(value)
          ) punto
          WHERE NOT p.is_voluntary
            AND p.status IN ${RONDAS_CERRADAS}
            AND p.scheduled_start_at >= ($1::date::timestamp AT TIME ZONE s.timezone)
            AND p.scheduled_start_at <  (($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)
            ${FILTRO_RECINTOS}
        )
        SELECT c.id AS checkpoint_id,
               c.name AS checkpoint_name,
               c.kind,
               s.name AS site_name,
               s.branch_name,
               count(*)::int AS esperados,
               count(*) FILTER (WHERE NOT e.escaneado)::int AS omitidos,
               round(100.0 * count(*) FILTER (WHERE NOT e.escaneado) / count(*), 1) AS pct_omision
        FROM esperado e
        JOIN checkpoints c ON c.tenant_id = e.tenant_id AND c.id = e.checkpoint_id
        JOIN sites s ON s.tenant_id = e.tenant_id AND s.id = e.site_id
        GROUP BY c.id, c.name, c.kind, s.name, s.branch_name
        HAVING count(*) FILTER (WHERE NOT e.escaneado) > 0
        ORDER BY omitidos DESC, pct_omision DESC, c.name
        LIMIT $6::int
      `,
      [...parametros, query.limit ?? 10],
    );

    return {
      range: rango,
      checkpoints: filas.map((f) => ({
        checkpointId: f.checkpoint_id,
        checkpointName: f.checkpoint_name,
        kind: f.kind,
        siteName: f.site_name,
        branchName: f.branch_name,
        expected: Number(f.esperados),
        missed: Number(f.omitidos),
        missedPct: Number(f.pct_omision),
      })),
    };
  }

  /**
   * Ranking de guardias. Se agrega en vivo sobre `patrols` y no sobre el cubo
   * por dos razones: el cubo no tiene dimension de guardia (agregarla lo
   * multiplicaria por la dotacion) y "rondas bajo umbral" depende del umbral
   * VIGENTE, que el admin puede cambiar — precalcularlo dejaria el historico
   * midiendo con una regla que ya no existe.
   *
   * Ordena de peor a mejor, igual que el resto del panel.
   */
  async guardRanking(scope: ChartScope, query: TopQueryDto) {
    const rango = resolverRango(query.from, query.to, MAX_DIAS_RANKING);
    const parametros = await this.parametros(scope, query, rango);
    const reglas = await this.rules.effective();

    const filas = await this.tenantContext.manager.query<FilaGuardia[]>(
      `
        SELECT u.id AS guard_id,
               (u.given_name || ' ' || u.family_name) AS guard_name,
               count(*)::int AS rondas,
               count(*) FILTER (WHERE p.compliance_pct IS NOT NULL)::int AS con_cumplimiento,
               round(avg(p.compliance_pct), 1) AS cumplimiento,
               count(*) FILTER (WHERE p.compliance_pct < $6::numeric)::int AS bajo_umbral
        FROM patrols p
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN users u ON u.id = p.guard_id
        WHERE NOT p.is_voluntary
          AND p.status IN ${RONDAS_CERRADAS}
          AND p.scheduled_start_at >= ($1::date::timestamp AT TIME ZONE s.timezone)
          AND p.scheduled_start_at <  (($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)
          ${FILTRO_RECINTOS}
        GROUP BY u.id, u.given_name, u.family_name
        ORDER BY cumplimiento NULLS LAST, rondas DESC
        LIMIT $7::int
      `,
      [...parametros, reglas.complianceThreshold, query.limit ?? 20],
    );

    return {
      range: rango,
      threshold: reglas.complianceThreshold,
      guards: filas.map((f) => ({
        guardId: f.guard_id,
        guardName: f.guard_name,
        patrols: Number(f.rondas),
        ratedPatrols: Number(f.con_cumplimiento),
        compliancePct: f.cumplimiento === null ? null : Number(f.cumplimiento),
        belowThreshold: Number(f.bajo_umbral),
      })),
    };
  }
}
