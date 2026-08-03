import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

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
}
