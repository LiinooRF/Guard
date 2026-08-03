import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreatePatrolDto } from './dto/create-patrol.dto';
import type { CreateRouteDto, RouteCheckpointDto, UpdateRouteDto } from './dto/create-route.dto';

interface RouteRow {
  id: string;
  site_id: string;
  name: string;
  estimated_duration_min: number;
  tolerance_min: number;
  version: number;
  is_active: boolean;
  checkpoints: Array<{
    id: string;
    name: string;
    position: number;
    isClosingPoint: boolean;
  }>;
}

@Injectable()
export class SupervisorService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * El SUPERVISOR esta limitado a SUS recintos asignados, no a todo el tenant.
   * Eso se verifica aparte del permiso (ver roles.ts) — aca, en cada consulta.
   */
  private async ensureAssignedSite(siteId: string, supervisorId: string) {
    const rows = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
      `SELECT true AS present FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, supervisorId],
    );
    if (!rows.length) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
  }

  private async routeSite(routeId: string): Promise<{ siteId: string; version: number }> {
    const rows = await this.tenantContext.manager.query<
      Array<{ site_id: string; version: number }>
    >(`SELECT site_id, version FROM routes WHERE id = $1`, [routeId]);
    const route = rows[0];
    if (!route) throw new NotFoundException('La ruta no existe');
    return { siteId: route.site_id, version: route.version };
  }

  /** Normaliza la secuencia: exactamente un punto de cierre (default: el ultimo). */
  private normalizeSequence(checkpoints: RouteCheckpointDto[]) {
    const ids = checkpoints.map((c) => c.checkpointId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Un punto no puede repetirse en la secuencia');
    }
    const marked = checkpoints.filter((c) => c.isClosingPoint);
    if (marked.length > 1) {
      throw new BadRequestException('Solo un punto puede cerrar la ronda');
    }
    return checkpoints.map((c, i) => ({
      checkpointId: c.checkpointId,
      position: i + 1,
      isClosingPoint: marked.length ? Boolean(c.isClosingPoint) : i === checkpoints.length - 1,
    }));
  }

  private async insertSequence(
    routeId: string,
    siteId: string,
    seq: ReturnType<SupervisorService['normalizeSequence']>,
  ) {
    for (const punto of seq) {
      const inserted = await this.tenantContext.manager.query<Array<{ checkpoint_id: string }>>(
        `INSERT INTO route_checkpoints (tenant_id, route_id, checkpoint_id, position, is_closing_point)
         SELECT app_tenant_id(), $1, c.id, $3, $4
         FROM checkpoints c
         WHERE c.id = $2 AND c.site_id = $5 AND c.is_active
         RETURNING checkpoint_id`,
        [routeId, punto.checkpointId, punto.position, punto.isClosingPoint, siteId],
      );
      if (!inserted.length) {
        // Punto inexistente, inactivo o de OTRO recinto: la transaccion del
        // request se revierte completa, no queda una ruta a medias.
        throw new BadRequestException(
          `El punto ${punto.checkpointId} no pertenece al recinto o esta inactivo`,
        );
      }
    }
  }

  async listRoutes(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<RouteRow[]>(
      `SELECT r.id, r.site_id, r.name, r.estimated_duration_min, r.tolerance_min,
              r.version, r.is_active,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'position', rc.position,
                'isClosingPoint', rc.is_closing_point
              ) ORDER BY rc.position) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS checkpoints
       FROM routes r
       LEFT JOIN route_checkpoints rc ON rc.route_id = r.id
       LEFT JOIN checkpoints c ON c.id = rc.checkpoint_id
       WHERE r.site_id = $1
       GROUP BY r.id
       ORDER BY r.name`,
      [siteId],
    );
    return rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      name: r.name,
      estimatedDurationMin: r.estimated_duration_min,
      toleranceMin: r.tolerance_min,
      version: r.version,
      isActive: r.is_active,
      checkpoints: r.checkpoints,
    }));
  }

  async createRoute(siteId: string, supervisorId: string, input: CreateRouteDto) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const seq = this.normalizeSequence(input.checkpoints);
    const routeId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO routes (id, tenant_id, site_id, name, estimated_duration_min, tolerance_min)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5)`,
      [routeId, siteId, input.name, input.estimatedDurationMin, input.toleranceMin ?? 15],
    );
    await this.insertSequence(routeId, siteId, seq);
    return { id: routeId, version: 1 };
  }

  async updateRoute(routeId: string, supervisorId: string, input: UpdateRouteDto) {
    const { siteId, version } = await this.routeSite(routeId);
    await this.ensureAssignedSite(siteId, supervisorId);

    const sets: string[] = [];
    const valores: unknown[] = [routeId];
    const agrega = (columna: string, valor: unknown) => {
      valores.push(valor);
      sets.push(`${columna} = $${valores.length}`);
    };
    if (input.name !== undefined) agrega('name', input.name);
    if (input.estimatedDurationMin !== undefined) {
      agrega('estimated_duration_min', input.estimatedDurationMin);
    }
    if (input.toleranceMin !== undefined) agrega('tolerance_min', input.toleranceMin);

    let nuevaVersion = version;
    if (input.checkpoints) {
      // Cambiar la secuencia SUBE la version. El historico no se toca: cada
      // ronda ejecutada lleva su propio snapshot de puntos.
      nuevaVersion = version + 1;
      agrega('version', nuevaVersion);
      await this.tenantContext.manager.query(
        `DELETE FROM route_checkpoints WHERE route_id = $1`,
        [routeId],
      );
      await this.insertSequence(routeId, siteId, this.normalizeSequence(input.checkpoints));
    }
    if (!sets.length) throw new BadRequestException('Nada que actualizar');

    await this.tenantContext.manager.query(
      `UPDATE routes SET ${sets.join(', ')} WHERE id = $1`,
      valores,
    );
    return { id: routeId, version: nuevaVersion };
  }

  async setRouteActive(routeId: string, supervisorId: string, isActive: boolean) {
    const { siteId } = await this.routeSite(routeId);
    await this.ensureAssignedSite(siteId, supervisorId);
    await this.tenantContext.manager.query(
      `UPDATE routes SET is_active = $2 WHERE id = $1`,
      [routeId, isActive],
    );
    return { id: routeId, isActive };
  }

  /**
   * Asignacion manual de una ronda. Congela el snapshot de puntos ESPERADOS al
   * momento de asignar: si la ruta cambia despues, esta ronda no se entera.
   */
  async createPatrol(routeId: string, supervisorId: string, input: CreatePatrolDto) {
    const { siteId } = await this.routeSite(routeId);
    await this.ensureAssignedSite(siteId, supervisorId);

    const inicio = new Date(input.scheduledStartAt);
    const fin = new Date(input.scheduledEndAt);
    if (fin <= inicio) {
      throw new BadRequestException('La ventana termina antes de empezar');
    }

    const guardias = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
      `SELECT user_id FROM memberships
       WHERE user_id = $1 AND role_key = 'GUARDIA'`,
      [input.guardId],
    );
    if (!guardias.length) {
      throw new NotFoundException('El guardia no existe en esta empresa');
    }

    const puntos = await this.tenantContext.manager.query<Array<{ checkpoint_id: string }>>(
      `SELECT checkpoint_id FROM route_checkpoints
       WHERE route_id = $1 ORDER BY position`,
      [routeId],
    );
    if (puntos.length < 2) {
      throw new BadRequestException('La ruta no tiene una secuencia valida de puntos');
    }

    const patrolId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO patrols (
        id, tenant_id, site_id, route_id, guard_id,
        scheduled_start_at, scheduled_end_at, expected_checkpoint_ids
      ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        patrolId,
        siteId,
        routeId,
        input.guardId,
        input.scheduledStartAt,
        input.scheduledEndAt,
        JSON.stringify(puntos.map((p) => p.checkpoint_id)),
      ],
    );
    return { id: patrolId, status: 'pendiente', expectedCheckpoints: puntos.length };
  }

  async listPatrols(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      route_name: string;
      guard_name: string;
      status: string;
      scheduled_start_at: Date;
      scheduled_end_at: Date;
      compliance_pct: string | null;
    }>>(
      `SELECT p.id, r.name AS route_name,
              (u.given_name || ' ' || u.family_name) AS guard_name,
              p.status, p.scheduled_start_at, p.scheduled_end_at, p.compliance_pct
       FROM patrols p
       JOIN routes r ON r.id = p.route_id
       JOIN users u ON u.id = p.guard_id
       WHERE p.site_id = $1
       ORDER BY p.scheduled_start_at DESC
       LIMIT 100`,
      [siteId],
    );
    return rows.map((p) => ({
      id: p.id,
      routeName: p.route_name,
      guardName: p.guard_name,
      status: p.status,
      scheduledStartAt: p.scheduled_start_at,
      scheduledEndAt: p.scheduled_end_at,
      compliancePct: p.compliance_pct === null ? null : Number(p.compliance_pct),
    }));
  }
}
