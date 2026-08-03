import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { computeCompliance, patrolRulesSchema, type ScanAnomaly } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreateScanDto } from './dto/create-scan.dto';

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
  constructor(private readonly tenantContext: TenantContextService) {}

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

    // Por ahora las reglas por defecto del producto; la resolucion por tenant
    // es el issue #16 y se enchufa aca cuando exista.
    const rules = patrolRulesSchema.parse({});
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
    // porcentaje real queda registrado y la alerta bajo umbral es #64.
    let closed = false;
    if (target.is_closing_point && !replay) {
      await this.tenantContext.manager.query(
        `UPDATE patrols
         SET status = 'completada', closed_at = now(), compliance_pct = $2
         WHERE id = $1 AND status = 'en_curso'`,
        [patrolId, compliance.pct],
      );
      closed = true;
    }

    return {
      replay,
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
