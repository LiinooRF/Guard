import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';

export interface StatsRange {
  readonly from?: string;
  readonly to?: string;
}

/**
 * Macro-estadisticas consolidadas del tenant (#103).
 *
 * Todo se agrega EN SQL a proposito. Traer las rondas al navegador para sumarlas
 * ahi no escala (un tenant con 40 recintos son decenas de miles de filas al mes)
 * y ademas expone al cliente datos que no necesita ver para dibujar un promedio.
 *
 * Las rondas voluntarias (#133) se excluyen de los promedios de cumplimiento:
 * son cobertura extra, no parte de lo programado. Contarlas inflaria o hundiria
 * el indicador segun el humor del guardia.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
  ) {}

  private rango(range: StatsRange) {
    return [range.from ?? null, range.to ?? null];
  }

  async overview(range: StatsRange) {
    const reglas = await this.rules.effective();
    const [desde, hasta] = this.rango(range);

    const [global] = await this.tenantContext.manager.query<Array<{
      rondas: string;
      completadas: string;
      incompletas: string;
      vencidas: string;
      cumplimiento: string | null;
      bajo_umbral: string;
    }>>(
      `SELECT count(*)::text AS rondas,
              count(*) FILTER (WHERE status = 'completada')::text AS completadas,
              count(*) FILTER (WHERE status = 'incompleta')::text AS incompletas,
              count(*) FILTER (WHERE status = 'vencida')::text AS vencidas,
              round(avg(compliance_pct) FILTER (WHERE compliance_pct IS NOT NULL), 1)::text
                AS cumplimiento,
              count(*) FILTER (WHERE compliance_pct < $3)::text AS bajo_umbral
       FROM patrols
       WHERE NOT is_voluntary
         AND ($1::timestamptz IS NULL OR scheduled_start_at >= $1)
         AND ($2::timestamptz IS NULL OR scheduled_start_at <= $2)`,
      [desde, hasta, reglas.complianceThreshold],
    );

    const porSucursal = await this.tenantContext.manager.query<Array<{
      branch_name: string;
      recintos: string;
      rondas: string;
      cumplimiento: string | null;
    }>>(
      `SELECT s.branch_name,
              count(DISTINCT s.id)::text AS recintos,
              count(p.id)::text AS rondas,
              round(avg(p.compliance_pct), 1)::text AS cumplimiento
       FROM sites s
       LEFT JOIN patrols p
         ON p.site_id = s.id AND NOT p.is_voluntary
        AND ($1::timestamptz IS NULL OR p.scheduled_start_at >= $1)
        AND ($2::timestamptz IS NULL OR p.scheduled_start_at <= $2)
       GROUP BY s.branch_name
       ORDER BY avg(p.compliance_pct) NULLS LAST`,
      [desde, hasta],
    );

    // El ranking arranca por el PEOR: el admin abre el panel para encontrar el
    // problema, no para felicitarse.
    const peoresRecintos = await this.tenantContext.manager.query<Array<{
      id: string;
      name: string;
      branch_name: string;
      rondas: string;
      cumplimiento: string | null;
    }>>(
      `SELECT s.id, s.name, s.branch_name,
              count(p.id)::text AS rondas,
              round(avg(p.compliance_pct), 1)::text AS cumplimiento
       FROM sites s
       JOIN patrols p ON p.site_id = s.id AND NOT p.is_voluntary
       WHERE p.compliance_pct IS NOT NULL
         AND ($1::timestamptz IS NULL OR p.scheduled_start_at >= $1)
         AND ($2::timestamptz IS NULL OR p.scheduled_start_at <= $2)
       GROUP BY s.id
       ORDER BY avg(p.compliance_pct)
       LIMIT 10`,
      [desde, hasta],
    );

    return {
      threshold: reglas.complianceThreshold,
      global: {
        patrols: Number(global?.rondas ?? 0),
        completed: Number(global?.completadas ?? 0),
        incomplete: Number(global?.incompletas ?? 0),
        expired: Number(global?.vencidas ?? 0),
        compliancePct: global?.cumplimiento === null ? null : Number(global?.cumplimiento),
        belowThreshold: Number(global?.bajo_umbral ?? 0),
      },
      byBranch: porSucursal.map((b) => ({
        branchName: b.branch_name,
        sites: Number(b.recintos),
        patrols: Number(b.rondas),
        compliancePct: b.cumplimiento === null ? null : Number(b.cumplimiento),
      })),
      worstSites: peoresRecintos.map((s) => ({
        siteId: s.id,
        siteName: s.name,
        branchName: s.branch_name,
        patrols: Number(s.rondas),
        compliancePct: s.cumplimiento === null ? null : Number(s.cumplimiento),
      })),
    };
  }

  /** Tendencia semanal: la serie que dibuja la grafica de evolucion. */
  async trend(range: StatsRange, branchName?: string) {
    const [desde, hasta] = this.rango(range);
    const rows = await this.tenantContext.manager.query<Array<{
      semana: Date;
      rondas: string;
      cumplimiento: string | null;
    }>>(
      `SELECT date_trunc('week', p.scheduled_start_at) AS semana,
              count(*)::text AS rondas,
              round(avg(p.compliance_pct), 1)::text AS cumplimiento
       FROM patrols p
       JOIN sites s ON s.id = p.site_id
       WHERE NOT p.is_voluntary
         AND ($1::timestamptz IS NULL OR p.scheduled_start_at >= $1)
         AND ($2::timestamptz IS NULL OR p.scheduled_start_at <= $2)
         AND ($3::text IS NULL OR s.branch_name = $3)
       GROUP BY semana
       ORDER BY semana`,
      [desde, hasta, branchName ?? null],
    );
    return rows.map((r) => ({
      week: r.semana,
      patrols: Number(r.rondas),
      compliancePct: r.cumplimiento === null ? null : Number(r.cumplimiento),
    }));
  }
}
