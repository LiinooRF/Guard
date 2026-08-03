import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MailQueueService } from '../mail/mail-queue.service';

/**
 * Dias sin actividad tras los cuales un tenant entra a la lista de fuga.
 *
 * Es un default de PLATAFORMA y por eso no vive en patrolRulesSchema: esa
 * cascada la configura cada empresa, y una empresa no puede decidir cuando la
 * plataforma la considera en riesgo de irse. El endpoint acepta ?inactivityDays
 * para ajustarlo sin deploy. Ver ## reglas en INTEGRACION.md.
 */
export const DEFAULT_INACTIVITY_DAYS = 7;

interface GlobalRow {
  active_tenants: number;
  suspended_tenants: number;
  active_guards: number;
  patrols_this_month: number;
  avg_compliance_pct: string | null;
  tenants_at_risk: number;
  last_offline_sync_at: Date | null;
  offline_sync_ops_24h: number;
}

interface TenantMetricRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'suspended';
  created_at: Date;
  active_guards: number;
  patrols_this_month: number;
  avg_compliance_pct: string | null;
  compliance_sample: number;
  last_activity_at: Date | null;
  days_since_activity: number | null;
  at_risk: boolean;
}

/**
 * Metricas globales de la plataforma. Issue #110.
 *
 * ESTO NO PASA POR RLS, a proposito. Cada consulta cruza todos los tenants
 * dentro de funciones SECURITY DEFINER (platform_global_metrics y
 * platform_tenant_metrics) que empiezan por assert_platform_superadmin. Es
 * correcto aca y solo aca: quien pregunta es la PLATAFORMA, no un cliente. La
 * pregunta "cuantas empresas hay y cuales estan por irse" no tiene respuesta
 * dentro de un tenant — con RLS activo devolveria cero filas siempre.
 *
 * La linea que no se cruza: esto entrega AGREGADOS (conteos, promedios, fechas
 * de ultima actividad), nunca filas de negocio. Para ver los datos de UNA
 * empresa sigue haciendo falta la ventana de soporte auditada de #109, que
 * exige motivo escrito, vence sola y el ADMIN del tenant puede leer. Si alguna
 * vez estas metricas empiezan a devolver nombres de guardias o direcciones de
 * recintos, dejaron de ser metricas y hay que moverlas detras de esa ventana.
 */
@Injectable()
export class PlatformMetricsService {
  private readonly logger = new Logger(PlatformMetricsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailQueue: MailQueueService,
  ) {}

  async overview(actorId: string, inactivityDays: number = DEFAULT_INACTIVITY_DAYS) {
    const { resumen, porTenant } = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);

      // Secuencial y no Promise.all: comparten el mismo query runner.
      const globales = await manager.query<GlobalRow[]>(
        `SELECT * FROM platform_global_metrics($1, $2)`,
        [actorId, inactivityDays],
      );
      const tenants = await manager.query<TenantMetricRow[]>(
        `SELECT * FROM platform_tenant_metrics($1, $2)`,
        [actorId, inactivityDays],
      );
      return { resumen: globales[0] ?? null, porTenant: tenants };
    });

    return {
      generatedAt: new Date().toISOString(),
      inactivityDays,
      tenants: {
        active: resumen?.active_tenants ?? 0,
        suspended: resumen?.suspended_tenants ?? 0,
        atRisk: resumen?.tenants_at_risk ?? 0,
      },
      operation: {
        activeGuards: resumen?.active_guards ?? 0,
        patrolsThisMonth: resumen?.patrols_this_month ?? 0,
        avgCompliancePct: this.numero(resumen?.avg_compliance_pct ?? null),
      },
      health: {
        mailQueue: await this.saludDeCorreo(),
        lastOfflineSyncAt: resumen?.last_offline_sync_at ?? null,
        offlineSyncOps24h: resumen?.offline_sync_ops_24h ?? 0,
      },
      byTenant: porTenant.map((row) => ({
        tenantId: row.tenant_id,
        slug: row.slug,
        displayName: row.display_name,
        status: row.status,
        createdAt: row.created_at,
        activeGuards: row.active_guards,
        patrolsThisMonth: row.patrols_this_month,
        avgCompliancePct: this.numero(row.avg_compliance_pct),
        // Cuantas rondas respaldan ese promedio: sin esto, un 100% sobre una
        // sola ronda se lee igual que un 100% sobre trescientas.
        complianceSample: row.compliance_sample,
        lastActivityAt: row.last_activity_at,
        daysSinceActivity: row.days_since_activity,
        atRisk: row.at_risk,
      })),
    };
  }

  /**
   * La cola vive en Redis, no en PostgreSQL: es lo unico que no se puede
   * agregar en SQL. Si Redis no responde, las metricas igual se entregan con la
   * cola marcada como no disponible — un panel de salud que se cae entero
   * porque uno de sus indicadores esta caido no sirve para diagnosticar nada.
   */
  private async saludDeCorreo() {
    try {
      const estado = await this.mailQueue.supportStatus();
      return {
        available: true,
        counts: estado.counts,
        failedRecent: estado.failed.length,
      };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'metricas_cola_correo_no_disponible',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return { available: false };
    }
  }

  /** numeric de PostgreSQL llega como string; el panel espera numero o null. */
  private numero(raw: string | null): number | null {
    if (raw === null) return null;
    const valor = Number(raw);
    return Number.isFinite(valor) ? valor : null;
  }
}
