import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { computeCompliance, type ScanAnomaly } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { MAIL_PROVIDER, type MailProvider } from '../mail/mail-provider';
import { RulesService } from '../rules/rules.service';
import type { CreateScanDto } from './dto/create-scan.dto';
import type { ReportEventDto } from './dto/report-event.dto';

/**
 * La regla que dio origen al producto: si el cumplimiento queda bajo el
 * umbral, la alerta va DIRECTO al admin de la empresa. Ver issue #64.
 */
const ALERTA_PANICO = {
  subject: 'PÁNICO: {{guard}} en {{site}}',
  text:
    '{{guard}} activó el botón de pánico en {{site}}.\n\n' +
    'Hora (servidor): {{at}}\n' +
    'Ubicación: {{location}}\n\n' +
    'Contacta al guardia y revisa el panel de VoxIA Control AHORA.',
} as const;

const ALERTA_EVENTO = {
  subject: 'Novedad de criticidad alta en {{site}}',
  text:
    '{{guard}} reportó una novedad de criticidad alta en {{site}}:\n\n' +
    '"{{text}}"\n\n' +
    'Hora (servidor): {{at}}\n' +
    'Ubicación: {{location}}\n\n' +
    'Revisa el detalle en el panel de VoxIA Control.',
} as const;

const ALERTA_BAJO_UMBRAL = {
  subject: 'Cumplimiento bajo el umbral: {{route}} en {{site}} ({{pct}}%)',
  text:
    'La ronda "{{route}}" del recinto {{site}} cerró con {{pct}}% de cumplimiento, ' +
    'bajo el umbral de {{threshold}}%.\n\n' +
    'Guardia: {{guard}}\n' +
    'Puntos escaneados: {{scanned}} de {{expected}}\n' +
    'Puntos sin escanear: {{missed}}\n\n' +
    'Revisa el detalle en el panel de VoxIA Control.',
} as const;

interface PatrolRow {
  id: string;
  status: 'pendiente' | 'en_curso' | 'completada' | 'incompleta' | 'vencida';
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  site_name: string;
  route_name: string;
  estimated_duration_min: number;
  checkpoints: Array<{
    id: string;
    name: string;
    position: number;
    isClosingPoint: boolean;
  }>;
}

@Injectable()
export class GuardService {
  private readonly logger = new Logger(GuardService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly rules: RulesService,
  ) {}

  async getHome(guardId: string) {
    const rows = await this.tenantContext.manager.query<PatrolRow[]>(
      `
        SELECT
          p.id,
          p.status,
          p.scheduled_start_at,
          p.scheduled_end_at,
          p.started_at,
          s.name AS site_name,
          r.name AS route_name,
          r.estimated_duration_min,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', c.id,
                'name', c.name,
                'position', rc.position,
                'isClosingPoint', rc.is_closing_point
              )
              ORDER BY rc.position
            ) FILTER (WHERE c.id IS NOT NULL),
            '[]'::jsonb
          ) AS checkpoints
        FROM patrols p
        JOIN sites s
          ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN routes r
          ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        LEFT JOIN route_checkpoints rc
          ON rc.tenant_id = p.tenant_id AND rc.route_id = p.route_id
        LEFT JOIN checkpoints c
          ON c.tenant_id = rc.tenant_id AND c.id = rc.checkpoint_id
        WHERE p.guard_id = $1
          AND p.status IN ('pendiente', 'en_curso')
        GROUP BY p.id, s.name, r.name, r.estimated_duration_min
        ORDER BY
          CASE p.status WHEN 'en_curso' THEN 0 ELSE 1 END,
          p.scheduled_start_at DESC
        LIMIT 1
      `,
      [guardId],
    );

    const patrol = rows[0];
    if (!patrol) {
      return {
        hasAssignment: false as const,
        message: 'No tienes un turno asignado en este momento.',
        connection: { status: 'online' as const },
        synchronization: { pendingItems: 0 },
      };
    }

    return {
      hasAssignment: true as const,
      shift: {
        scheduledStartAt: patrol.scheduled_start_at,
        scheduledEndAt: patrol.scheduled_end_at,
      },
      patrol: {
        id: patrol.id,
        status: patrol.status,
        siteName: patrol.site_name,
        routeName: patrol.route_name,
        estimatedDurationMin: patrol.estimated_duration_min,
        startedAt: patrol.started_at,
        completedCheckpointCount: 0,
        checkpoints: patrol.checkpoints,
      },
      connection: { status: 'online' as const },
      synchronization: { pendingItems: 0 },
    };
  }

  async startPatrol(patrolId: string, guardId: string) {
    const rows = await this.tenantContext.manager.query<
      Array<{ id: string; status: string; started_at: Date }>
    >(
      `
        WITH updated AS (
          UPDATE patrols
          SET status = 'en_curso', started_at = now()
          WHERE id = $1 AND guard_id = $2 AND status = 'pendiente'
          RETURNING id, status, started_at
        )
        SELECT id, status, started_at FROM updated
      `,
      [patrolId, guardId],
    );

    if (rows[0]) return rows[0];

    const existing = await this.tenantContext.manager.query<Array<{ status: string }>>(
      `SELECT status FROM patrols WHERE id = $1 AND guard_id = $2`,
      [patrolId, guardId],
    );
    if (!existing[0]) throw new NotFoundException('La ronda asignada no existe');
    throw new ConflictException('La ronda ya fue iniciada o cerrada');
  }

  /**
   * El nucleo del producto: el guardia acerca el telefono a la etiqueta y esto
   * queda registrado. Al escanear el punto de cierre, la ronda se cierra sola
   * con su porcentaje de cumplimiento.
   *
   * Idempotente por `clientScanId`: el reenvio tras recuperar señal devuelve el
   * escaneo original. Las anomalias MARCAN, no rechazan (ver CLAUDE.md).
   */
  async registerScan(patrolId: string, guardId: string, input: CreateScanDto) {
    const patrols = await this.tenantContext.manager.query<Array<{
      id: string;
      status: string;
      route_id: string;
      expected_checkpoint_ids: string[];
    }>>(
      `SELECT id, status, route_id, expected_checkpoint_ids
       FROM patrols WHERE id = $1 AND guard_id = $2`,
      [patrolId, guardId],
    );
    const patrol = patrols[0];
    if (!patrol) throw new NotFoundException('La ronda asignada no existe');
    if (!['pendiente', 'en_curso'].includes(patrol.status)) {
      throw new ConflictException('La ronda ya está cerrada');
    }

    // El primer escaneo inicia la ronda si venia pendiente: en terreno el
    // guardia escanea, no aprieta botones.
    if (patrol.status === 'pendiente') {
      await this.tenantContext.manager.query(
        `UPDATE patrols SET status = 'en_curso', started_at = now()
         WHERE id = $1 AND status = 'pendiente'`,
        [patrolId],
      );
    }

    const resolved = await this.tenantContext.manager.query<Array<{
      tag_id: string;
      checkpoint_id: string;
      checkpoint_name: string;
      kind: 'normal' | 'acceso_critico';
      latitude: string | null;
      longitude: string | null;
      is_closing_point: boolean | null;
    }>>(
      `SELECT tag.id AS tag_id, c.id AS checkpoint_id, c.name AS checkpoint_name,
              c.kind, c.latitude, c.longitude, rc.is_closing_point
       FROM tags tag
       JOIN checkpoints c ON c.id = tag.checkpoint_id
       LEFT JOIN route_checkpoints rc
         ON rc.route_id = $2 AND rc.checkpoint_id = c.id
       WHERE tag.uid = $1 AND tag.is_active`,
      [input.uid.trim(), patrol.route_id],
    );
    const target = resolved[0];
    if (!target) throw new NotFoundException('La etiqueta no resuelve a ningún punto');
    if (!patrol.expected_checkpoint_ids.includes(target.checkpoint_id)) {
      throw new ConflictException('El punto escaneado no pertenece a esta ronda');
    }

    // Reglas efectivas del tenant (#16): el umbral o el radio GPS que cambie
    // el admin rigen la proxima ronda, sin deploy.
    const rules = await this.rules.effective();
    const anomalies: ScanAnomaly[] = [];
    if (input.latitude === undefined || input.longitude === undefined) {
      if (rules.gpsSharingRequired) anomalies.push('sin_fix_gps');
    } else if (target.latitude !== null && target.longitude !== null) {
      const distanceM = haversineM(
        input.latitude, input.longitude,
        Number(target.latitude), Number(target.longitude),
      );
      if (distanceM > rules.gpsValidationRadiusM) anomalies.push('fuera_de_radio_gps');
    }
    if (input.scannedAt) {
      const driftMs = Math.abs(Date.now() - new Date(input.scannedAt).getTime());
      if (driftMs > 5 * 60_000) anomalies.push('reloj_desfasado');
    }

    const inserted = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO scans (
        tenant_id, patrol_id, checkpoint_id, tag_id, method, client_scan_id,
        scanned_at_device, latitude, longitude, accuracy_m, anomalies
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (tenant_id, patrol_id, client_scan_id) DO NOTHING
      RETURNING id`,
      [
        patrolId,
        target.checkpoint_id,
        target.tag_id,
        input.method,
        input.clientScanId,
        input.scannedAt ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.accuracyM ?? null,
        JSON.stringify(anomalies),
      ],
    );
    const replay = !inserted.length;

    const allScans = await this.tenantContext.manager.query<Array<{
      checkpoint_id: string;
      anomalies: ScanAnomaly[];
    }>>(
      `SELECT checkpoint_id, anomalies FROM scans WHERE patrol_id = $1`,
      [patrolId],
    );
    const compliance = computeCompliance(
      patrol.expected_checkpoint_ids,
      allScans.map((s) => ({ checkpointId: s.checkpoint_id, anomalies: s.anomalies })),
      rules.complianceThreshold,
    );

    // El escaneo del punto de cierre cierra la ronda, este o no completa: el
    // porcentaje real queda registrado.
    let closed = false;
    if (target.is_closing_point && !replay) {
      await this.tenantContext.manager.query(
        `UPDATE patrols
         SET status = 'completada', closed_at = now(), compliance_pct = $2
         WHERE id = $1 AND status = 'en_curso'`,
        [patrolId, compliance.pct],
      );
      closed = true;

      if (compliance.belowThreshold) {
        await this.alertarBajoUmbral(patrolId, compliance, rules.complianceThreshold);
      }
    }

    return {
      replay,
      alertSent: closed && compliance.belowThreshold,
      checkpoint: {
        id: target.checkpoint_id,
        name: target.checkpoint_name,
        kind: target.kind,
      },
      anomalies,
      progress: {
        scanned: compliance.scanned,
        expected: compliance.expected,
        pct: compliance.pct,
        missedCheckpointIds: compliance.missedCheckpointIds,
      },
      patrol: {
        id: patrolId,
        status: closed ? 'completada' : 'en_curso',
        compliancePct: closed ? compliance.pct : null,
      },
    };
  }

  /**
   * Novedades y panico en un solo modelo (#123): el panico es la criticidad
   * maxima, no otra tabla. El registro es append-only a nivel de PostgreSQL
   * (#124): esta API ni siquiera tiene permiso de UPDATE o DELETE sobre
   * field_events, asi que no existe el camino para reescribir la historia.
   */
  async reportEvent(guardId: string, input: ReportEventDto) {
    let patrol: { id: string; site_id: string } | undefined;
    if (input.patrolId) {
      const rows = await this.tenantContext.manager.query<Array<{ id: string; site_id: string }>>(
        `SELECT id, site_id FROM patrols WHERE id = $1 AND guard_id = $2`,
        [input.patrolId, guardId],
      );
      patrol = rows[0];
      if (!patrol) throw new NotFoundException('La ronda indicada no existe');
    } else {
      const rows = await this.tenantContext.manager.query<Array<{ id: string; site_id: string }>>(
        `SELECT id, site_id FROM patrols
         WHERE guard_id = $1
         ORDER BY scheduled_start_at DESC
         LIMIT 1`,
        [guardId],
      );
      patrol = rows[0];
      if (!patrol) {
        throw new ConflictException('No hay una ronda que asocie el evento a un recinto');
      }
    }

    const inserted = await this.tenantContext.manager.query<
      Array<{ id: string; reported_at_server: Date }>
    >(
      `INSERT INTO field_events (
        tenant_id, site_id, patrol_id, guard_id, criticality, text,
        corrects_event_id, client_event_id, latitude, longitude, accuracy_m,
        reported_at_device
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tenant_id, guard_id, client_event_id) DO NOTHING
      RETURNING id, reported_at_server`,
      [
        patrol.site_id,
        patrol.id,
        guardId,
        input.criticality,
        input.text ?? null,
        input.correctsEventId ?? null,
        input.clientEventId,
        input.latitude ?? null,
        input.longitude ?? null,
        input.accuracyM ?? null,
        input.reportedAt ?? null,
      ],
    );

    const replay = !inserted.length;
    let eventId = inserted[0]?.id;
    if (replay) {
      const existing = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `SELECT id FROM field_events WHERE guard_id = $1 AND client_event_id = $2`,
        [guardId, input.clientEventId],
      );
      eventId = existing[0]?.id;
    }

    // El escalamiento configurable por tenant es #126; por ahora, alta y
    // panico avisan directo a los admins. El reenvio idempotente NO re-avisa.
    let notified = false;
    if (!replay && (input.criticality === 'alta' || input.criticality === 'panico')) {
      notified = await this.notificarEvento(patrol.site_id, guardId, input);
    }

    return {
      id: eventId,
      replay,
      criticality: input.criticality,
      siteId: patrol.site_id,
      patrolId: patrol.id,
      notified,
    };
  }

  /** Un fallo de correo jamas rompe el registro del evento. */
  private async notificarEvento(siteId: string, guardId: string, input: ReportEventDto) {
    try {
      const contexto = await this.tenantContext.manager.query<Array<{
        tenant_id: string;
        site_name: string;
        guard_name: string;
      }>>(
        `SELECT s.tenant_id, s.name AS site_name,
                (u.given_name || ' ' || u.family_name) AS guard_name
         FROM sites s, users u
         WHERE s.id = $1 AND u.id = $2`,
        [siteId, guardId],
      );
      const info = contexto[0];
      if (!info) return false;

      const admins = await this.tenantContext.manager.query<Array<{ email: string }>>(
        `SELECT u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.role_key = 'ADMIN' AND u.is_active AND u.email IS NOT NULL`,
      );
      if (!admins.length) return false;

      const plantilla = input.criticality === 'panico' ? ALERTA_PANICO : ALERTA_EVENTO;
      const vars = {
        site: info.site_name,
        guard: info.guard_name,
        text: input.text ?? '(sin texto)',
        at: new Date().toISOString(),
        location:
          input.latitude !== undefined && input.longitude !== undefined
            ? `${input.latitude}, ${input.longitude}`
            : 'sin GPS',
      };
      for (const admin of admins) {
        await this.mail.send(admin.email, plantilla, vars, info.tenant_id);
      }
      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'alerta_evento_fallo',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }

  /**
   * Un fallo de correo JAMAS puede romper el escaneo: el guardia esta en
   * terreno y su registro vale mas que la notificacion. Se avisa en el log y
   * la ronda queda cerrada igual, con su porcentaje persistido.
   */
  private async alertarBajoUmbral(
    patrolId: string,
    compliance: { pct: number; scanned: number; expected: number; missedCheckpointIds: readonly string[] },
    threshold: number,
  ) {
    try {
      const contexto = await this.tenantContext.manager.query<Array<{
        tenant_id: string;
        site_name: string;
        route_name: string;
        guard_name: string;
      }>>(
        `SELECT p.tenant_id, s.name AS site_name, r.name AS route_name,
                (u.given_name || ' ' || u.family_name) AS guard_name
         FROM patrols p
         JOIN sites s ON s.id = p.site_id
         JOIN routes r ON r.id = p.route_id
         JOIN users u ON u.id = p.guard_id
         WHERE p.id = $1`,
        [patrolId],
      );
      const info = contexto[0];
      if (!info) return;

      const admins = await this.tenantContext.manager.query<Array<{ email: string }>>(
        `SELECT u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.role_key = 'ADMIN' AND u.is_active AND u.email IS NOT NULL`,
      );
      if (!admins.length) {
        this.logger.warn(
          JSON.stringify({ event: 'umbral_sin_destinatarios', patrol_id: patrolId }),
        );
        return;
      }

      const vars = {
        site: info.site_name,
        route: info.route_name,
        guard: info.guard_name,
        pct: compliance.pct,
        threshold,
        scanned: compliance.scanned,
        expected: compliance.expected,
        missed: compliance.missedCheckpointIds.length,
      };
      for (const admin of admins) {
        await this.mail.send(admin.email, ALERTA_BAJO_UMBRAL, vars, info.tenant_id);
      }
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'alerta_umbral_fallo',
          patrol_id: patrolId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/** Distancia en metros entre dos coordenadas (formula de haversine). */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (v: number) => (v * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
