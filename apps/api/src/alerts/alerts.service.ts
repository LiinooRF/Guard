import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { PushService } from '../push/push.service';
import { ALERTS_JOB_NAME, ALERTS_QUEUE_NAME } from './alerts-queue.constants';
import type { AlertDetectionJob } from './alerts-queue.types';

type AlertType = 'no_iniciada' | 'atrasada' | 'incompleta' | 'anomalia' | 'incidente_grave';
type Severity = 'advertencia' | 'critica';

interface PatrolAlertContext {
  tenant_id: string;
  site_id: string;
  site_name: string;
  route_name: string;
  guard_name: string;
  status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  entry_tolerance_min: number;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly push: PushService,
    @InjectQueue(ALERTS_QUEUE_NAME) private readonly queue: Queue<AlertDetectionJob>,
  ) {}

  /** Programa al crear la ronda: el aviso no depende de que haya un panel abierto. */
  async schedulePatrol(patrolId: string): Promise<void> {
    try {
      const context = await this.patrolContext(patrolId);
      if (!context) return;
      const startAt = context.scheduled_start_at.getTime() + context.entry_tolerance_min * 60_000;
      await Promise.all([
        this.enqueue(context.tenant_id, patrolId, 'no_iniciada', startAt),
        this.enqueue(context.tenant_id, patrolId, 'atrasada', context.scheduled_end_at.getTime()),
      ]);
    } catch (error) {
      // La ronda ya quedó guardada: Redis caído no puede revertir la operación de terreno.
      this.logger.warn(JSON.stringify({
        event: 'programacion_alerta_fallo', patrol_id: patrolId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async detectScheduled(patrolId: string, kind: 'no_iniciada' | 'atrasada') {
    const context = await this.patrolContext(patrolId);
    if (!context) return { created: false, reason: 'patrol_not_found' };
    if (kind === 'no_iniciada' && context.status !== 'pendiente') {
      return { created: false, reason: 'already_started' };
    }
    if (kind === 'atrasada' && context.status !== 'en_curso') {
      return { created: false, reason: 'not_in_progress' };
    }
    return this.createAlert({
      type: kind,
      severity: kind === 'atrasada' ? 'critica' : 'advertencia',
      dedupeKey: `patrol:${patrolId}:${kind}`,
      patrolId,
      siteId: context.site_id,
      title: kind === 'no_iniciada' ? 'Ronda no iniciada a tiempo' : 'Ronda atrasada',
      details: `${context.route_name} · ${context.guard_name}`,
      pushBody: `${context.site_name}: ${kind === 'no_iniciada' ? 'ronda sin iniciar' : 'ronda fuera de plazo'}`,
    });
  }

  async recordIncomplete(patrolId: string): Promise<void> {
    const context = await this.patrolContext(patrolId);
    if (!context) return;
    await this.createAlert({
      type: 'incompleta', severity: 'advertencia', dedupeKey: `patrol:${patrolId}:incompleta`,
      patrolId, siteId: context.site_id, title: 'Ronda incompleta',
      details: `${context.route_name} · ${context.guard_name}`,
      pushBody: `${context.site_name}: ronda incompleta`,
    });
  }

  async recordAnomaly(patrolId: string, scanId: string, anomalies: readonly string[]): Promise<void> {
    if (!anomalies.length) return;
    const context = await this.patrolContext(patrolId);
    if (!context) return;
    await this.createAlert({
      type: 'anomalia', severity: 'advertencia', dedupeKey: `scan:${scanId}:anomalia`,
      patrolId, siteId: context.site_id, title: 'Escaneo con anomalías',
      details: anomalies.join(', '), pushBody: `${context.site_name}: escaneo sospechoso`,
    });
  }

  async recordSevereEvent(eventId: string, patrolId: string, criticality: string): Promise<void> {
    if (!['alta', 'panico'].includes(criticality)) return;
    const context = await this.patrolContext(patrolId);
    if (!context) return;
    await this.createAlert({
      type: 'incidente_grave', severity: 'critica', dedupeKey: `event:${eventId}:grave`,
      patrolId, eventId, siteId: context.site_id, title: 'Incidente grave reportado',
      details: criticality === 'panico' ? 'Alerta de pánico' : 'Criticidad alta',
      pushBody: `${context.site_name}: incidente grave`,
    });
  }

  async list(supervisorId: string) {
    const rows = await this.tenantContext.manager.query<Array<{
      id: string; alert_type: AlertType; severity: Severity; title: string; details: string | null;
      site_id: string; site_name: string; patrol_id: string | null; field_event_id: string | null;
      detected_at: Date; attended_at: Date | null; attendance_comment: string | null;
      attended_by_name: string | null;
    }>>(
      `SELECT a.id, a.alert_type, a.severity, a.title, a.details,
              a.site_id, s.name AS site_name, a.patrol_id, a.field_event_id,
              a.detected_at, a.attended_at, a.attendance_comment,
              CASE WHEN actor.id IS NULL THEN NULL
                   ELSE trim(actor.given_name || ' ' || actor.family_name) END AS attended_by_name
       FROM operational_alerts a
       JOIN supervisor_sites scope ON scope.site_id = a.site_id AND scope.supervisor_id = $1
       JOIN sites s ON s.id = a.site_id
       LEFT JOIN users actor ON actor.id = a.attended_by
       ORDER BY (a.attended_at IS NULL) DESC, a.detected_at DESC LIMIT 100`,
      [supervisorId],
    );
    return rows.map((row) => ({
      id: row.id, type: row.alert_type, severity: row.severity, title: row.title,
      details: row.details, siteId: row.site_id, siteName: row.site_name,
      patrolId: row.patrol_id, eventId: row.field_event_id, detectedAt: row.detected_at,
      attendedAt: row.attended_at, attendedByName: row.attended_by_name,
      attendanceComment: row.attendance_comment,
    }));
  }

  async attend(alertId: string, supervisorId: string, comment: string) {
    const rows = await this.tenantContext.manager.query<Array<{ attended_at: Date }>>(
      `UPDATE operational_alerts a SET attended_at = now(), attended_by = $2,
              attendance_comment = trim($3)
       WHERE a.id = $1 AND a.attended_at IS NULL
         AND EXISTS (SELECT 1 FROM supervisor_sites scope
                     WHERE scope.site_id = a.site_id AND scope.supervisor_id = $2)
       RETURNING attended_at`,
      [alertId, supervisorId, comment],
    );
    if (rows[0]) return { id: alertId, attendedAt: rows[0].attended_at, attendedBy: supervisorId };
    const existing = await this.tenantContext.manager.query<Array<{ attended_at: Date | null }>>(
      `SELECT a.attended_at FROM operational_alerts a
       JOIN supervisor_sites scope ON scope.site_id = a.site_id AND scope.supervisor_id = $2
       WHERE a.id = $1`,
      [alertId, supervisorId],
    );
    if (!existing.length) throw new NotFoundException('La alerta no existe');
    throw new ConflictException('La alerta ya fue atendida');
  }

  private async createAlert(input: {
    type: AlertType; severity: Severity; dedupeKey: string; patrolId?: string; eventId?: string;
    siteId: string; title: string; details: string; pushBody: string;
  }) {
    const rows = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO operational_alerts (
         tenant_id, site_id, patrol_id, field_event_id, alert_type, severity,
         dedupe_key, title, details
       ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
      [input.siteId, input.patrolId ?? null, input.eventId ?? null, input.type,
       input.severity, input.dedupeKey, input.title, input.details],
    );
    const alert = rows[0];
    if (!alert) return { created: false, reason: 'duplicate' };
    const supervisors = await this.tenantContext.manager.query<Array<{ supervisor_id: string }>>(
      `SELECT supervisor_id FROM supervisor_sites WHERE site_id = $1`, [input.siteId],
    );
    await this.push.send(
      supervisors.map((row) => row.supervisor_id),
      {
        title: input.title, body: input.pushBody,
        deepLink: input.eventId
          ? { destino: 'evento', id: input.eventId, siteId: input.siteId }
          : { destino: 'ronda', id: input.patrolId, siteId: input.siteId },
        urgency: input.severity === 'critica' ? 'alta' : 'normal',
        collapseKey: `operational-alert:${alert.id}`,
      },
      { idempotencyKey: `operational-alert:${alert.id}` },
    );
    return { created: true, id: alert.id };
  }

  private async patrolContext(patrolId: string): Promise<PatrolAlertContext | undefined> {
    const rows = await this.tenantContext.manager.query<PatrolAlertContext[]>(
      `SELECT p.tenant_id, p.site_id, s.name AS site_name, r.name AS route_name,
              trim(u.given_name || ' ' || u.family_name) AS guard_name, p.status,
              p.scheduled_start_at, p.scheduled_end_at,
              COALESCE(sh.entry_tolerance_min, r.tolerance_min, 0)::int AS entry_tolerance_min
       FROM patrols p JOIN sites s ON s.id = p.site_id JOIN routes r ON r.id = p.route_id
       JOIN users u ON u.id = p.guard_id
       LEFT JOIN shift_assignments sa ON sa.id = p.shift_assignment_id
       LEFT JOIN shifts sh ON sh.id = sa.shift_id WHERE p.id = $1`,
      [patrolId],
    );
    return rows[0];
  }

  private enqueue(tenantId: string, patrolId: string, kind: AlertDetectionJob['kind'], at: number) {
    const key = `${tenantId}:${patrolId}:${kind}`;
    return this.queue.add(
      ALERTS_JOB_NAME, { tenantId, patrolId, kind },
      {
        jobId: createHash('sha256').update(key).digest('hex'),
        delay: Math.max(0, at - Date.now()), attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: false, removeOnFail: false,
      },
    );
  }
}
