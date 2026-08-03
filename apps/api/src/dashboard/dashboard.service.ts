import { Injectable } from '@nestjs/common';
import type { Role } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

interface OverviewRow {
  site_count: number;
  guard_count: number;
  pending_patrol_count: number;
  active_patrol_count: number;
  completed_patrol_count: number;
}

interface PatrolSummaryRow {
  id: string;
  site_name: string;
  route_name: string;
  status: string;
  scheduled_start_at: Date;
}

@Injectable()
export class DashboardService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async getTenantOverview(userId: string, role: Role) {
    const supervisorScoped = role === 'SUPERVISOR';
    const scopeParameters = [supervisorScoped, userId];
    const visibleSites = `
      SELECT site.id
      FROM sites site
      WHERE NOT $1::boolean
        OR EXISTS (
          SELECT 1
          FROM supervisor_sites assignment
          WHERE assignment.site_id = site.id
            AND assignment.supervisor_id = $2
        )
    `;

    const [overviewRows, patrols] = await Promise.all([
      this.tenantContext.manager.query<OverviewRow[]>(
        `
          WITH visible_sites AS (${visibleSites})
          SELECT
            (SELECT count(*)::int FROM visible_sites) AS site_count,
            CASE
              WHEN $1::boolean THEN (
                SELECT count(DISTINCT patrol.guard_id)::int
                FROM patrols patrol
                WHERE patrol.site_id IN (SELECT id FROM visible_sites)
              )
              ELSE (
                SELECT count(*)::int
                FROM memberships membership
                WHERE membership.role_key = 'GUARDIA'
              )
            END AS guard_count,
            (
              SELECT count(*)::int FROM patrols patrol
              WHERE patrol.site_id IN (SELECT id FROM visible_sites)
                AND patrol.status = 'pendiente'
            ) AS pending_patrol_count,
            (
              SELECT count(*)::int FROM patrols patrol
              WHERE patrol.site_id IN (SELECT id FROM visible_sites)
                AND patrol.status = 'en_curso'
            ) AS active_patrol_count,
            (
              SELECT count(*)::int FROM patrols patrol
              WHERE patrol.site_id IN (SELECT id FROM visible_sites)
                AND patrol.status = 'completada'
            ) AS completed_patrol_count
        `,
        scopeParameters,
      ),
      this.tenantContext.manager.query<PatrolSummaryRow[]>(
        `
          WITH visible_sites AS (${visibleSites})
          SELECT
            patrol.id,
            site.name AS site_name,
            route.name AS route_name,
            patrol.status,
            patrol.scheduled_start_at
          FROM patrols patrol
          JOIN visible_sites visible ON visible.id = patrol.site_id
          JOIN sites site ON site.id = patrol.site_id
          JOIN routes route ON route.id = patrol.route_id
          ORDER BY
            CASE patrol.status WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END,
            patrol.scheduled_start_at DESC
          LIMIT 5
        `,
        scopeParameters,
      ),
    ]);

    const overview = overviewRows[0] ?? {
      site_count: 0,
      guard_count: 0,
      pending_patrol_count: 0,
      active_patrol_count: 0,
      completed_patrol_count: 0,
    };

    return {
      scope: supervisorScoped ? 'assigned_sites' : 'tenant',
      metrics: {
        sites: overview.site_count,
        guards: overview.guard_count,
        pendingPatrols: overview.pending_patrol_count,
        activePatrols: overview.active_patrol_count,
        completedPatrols: overview.completed_patrol_count,
      },
      patrols: patrols.map((patrol) => ({
        id: patrol.id,
        siteName: patrol.site_name,
        routeName: patrol.route_name,
        status: patrol.status,
        scheduledStartAt: patrol.scheduled_start_at,
      })),
    };
  }
}
