import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import type { AssignShiftDto, CreateShiftDto } from './dto/create-shift.dto';
import type { CreatePatrolDto } from './dto/create-patrol.dto';
import type {
  CreateRouteDto,
  RouteCheckpointDto,
  RouteOrderMode,
  UpdateRouteDto,
} from './dto/create-route.dto';

interface RouteRow {
  id: string;
  site_id: string;
  name: string;
  estimated_duration_min: number;
  tolerance_min: number;
  version: number;
  is_active: boolean;
  order_mode: RouteOrderMode;
  checkpoints: Array<{
    id: string;
    name: string;
    position: number;
    isClosingPoint: boolean;
    isAnchor: boolean;
  }>;
}

interface PuntoSnapshot {
  checkpoint_id: string;
  is_closing_point: boolean;
  is_anchor: boolean;
}

@Injectable()
export class SupervisorService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
  ) {}

  /**
   * El SUPERVISOR esta limitado a SUS recintos asignados, no a todo el tenant.
   * Eso se verifica aparte del permiso (ver roles.ts) — aca, en cada consulta.
   */
  /** Publico: SchedulingService lo reusa. Duplicarlo seria duplicar un control de acceso. */
  async ensureAssignedSite(siteId: string, supervisorId: string) {
    const rows = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
      `SELECT true AS present FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, supervisorId],
    );
    if (!rows.length) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
  }

  private async routeSite(
    routeId: string,
  ): Promise<{ siteId: string; version: number; orderMode: RouteOrderMode }> {
    const rows = await this.tenantContext.manager.query<
      Array<{ site_id: string; version: number; order_mode: RouteOrderMode }>
    >(`SELECT site_id, version, order_mode FROM routes WHERE id = $1`, [routeId]);
    const route = rows[0];
    if (!route) throw new NotFoundException('La ruta no existe');
    return { siteId: route.site_id, version: route.version, orderMode: route.order_mode ?? 'fijo' };
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
      isAnchor: Boolean(c.isAnchor),
    }));
  }

  private async insertSequence(
    routeId: string,
    siteId: string,
    seq: ReturnType<SupervisorService['normalizeSequence']>,
  ) {
    for (const punto of seq) {
      const inserted = await this.tenantContext.manager.query<Array<{ checkpoint_id: string }>>(
        `INSERT INTO route_checkpoints (tenant_id, route_id, checkpoint_id, position, is_closing_point, is_anchor)
         SELECT app_tenant_id(), $1, c.id, $3, $4, $6
         FROM checkpoints c
         WHERE c.id = $2 AND c.site_id = $5 AND c.is_active
         RETURNING checkpoint_id`,
        [routeId, punto.checkpointId, punto.position, punto.isClosingPoint, siteId, punto.isAnchor],
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

  /** Fisher-Yates in place. Los indices son validos por construccion. */
  private barajar<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
  }

  /**
   * Sortea el orden del snapshot segun el modo. El punto de cierre SIEMPRE va
   * al final: es lo que cierra la ronda y dispara el informe. En
   * 'aleatorio_con_anclas' las anclas conservan su indice y solo se barajan
   * los puntos libres.
   */
  /** Publico: el generador de rondas sortea con la misma logica. */
  sortearOrden(puntos: PuntoSnapshot[], modo: RouteOrderMode): string[] {
    if (modo === 'fijo') return puntos.map((p) => p.checkpoint_id);

    const cierre = puntos.filter((p) => p.is_closing_point);
    const resto = puntos.filter((p) => !p.is_closing_point);

    if (modo === 'aleatorio') {
      this.barajar(resto);
      return [...resto, ...cierre].map((p) => p.checkpoint_id);
    }

    // aleatorio_con_anclas
    const indicesLibres = resto
      .map((p, i) => (p.is_anchor ? -1 : i))
      .filter((i) => i >= 0);
    const libres = indicesLibres.map((i) => resto[i]!);
    this.barajar(libres);
    const resultado = [...resto];
    indicesLibres.forEach((idx, j) => {
      resultado[idx] = libres[j]!;
    });
    return [...resultado, ...cierre].map((p) => p.checkpoint_id);
  }

  async listRoutes(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<RouteRow[]>(
      `SELECT r.id, r.site_id, r.name, r.estimated_duration_min, r.tolerance_min,
              r.version, r.is_active, r.order_mode,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'position', rc.position,
                'isClosingPoint', rc.is_closing_point, 'isAnchor', rc.is_anchor
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
      orderMode: r.order_mode,
      checkpoints: r.checkpoints,
    }));
  }

  async createRoute(siteId: string, supervisorId: string, input: CreateRouteDto) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const seq = this.normalizeSequence(input.checkpoints);
    const routeId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO routes (id, tenant_id, site_id, name, estimated_duration_min, tolerance_min, order_mode)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6)`,
      [
        routeId,
        siteId,
        input.name,
        input.estimatedDurationMin,
        input.toleranceMin ?? 15,
        input.orderMode ?? 'fijo',
      ],
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
    if (input.orderMode !== undefined) agrega('order_mode', input.orderMode);

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
   *
   * Anti-predictibilidad (#65): el orden se SORTEA aca, al generar la ronda, y
   * queda congelado en el snapshot. Dos rondas del mismo turno en dias
   * distintos llevan ordenes distintos, y el informe muestra exactamente el
   * orden que correspondia.
   */
  async createPatrol(routeId: string, supervisorId: string, input: CreatePatrolDto) {
    const { siteId, orderMode } = await this.routeSite(routeId);
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

    const puntos = await this.tenantContext.manager.query<PuntoSnapshot[]>(
      `SELECT checkpoint_id, is_closing_point, is_anchor FROM route_checkpoints
       WHERE route_id = $1 ORDER BY position`,
      [routeId],
    );
    if (puntos.length < 2) {
      throw new BadRequestException('La ruta no tiene una secuencia valida de puntos');
    }

    // La regla del tenant FUERZA el sorteo sobre rutas 'fijo'; el modo de la
    // ruta refina (una ruta con anclas conserva sus anclas).
    const reglas = await this.rules.effective();
    let modo: RouteOrderMode = orderMode;
    if (modo === 'fijo' && reglas.randomizeRouteOrder) modo = 'aleatorio';

    const orden = this.sortearOrden(puntos, modo);

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
        JSON.stringify(orden),
      ],
    );
    return {
      id: patrolId,
      status: 'pendiente',
      expectedCheckpoints: orden.length,
      orderMode: modo,
    };
  }

  // ------------------------------------------------------------------ turnos

  async listShifts(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      id: string; name: string; starts_at: string; ends_at: string;
      weekdays: number[]; entry_tolerance_min: number; is_active: boolean;
      asignados_hoy: string;
    }>>(
      `SELECT s.id, s.name, s.starts_at, s.ends_at, s.weekdays,
              s.entry_tolerance_min, s.is_active,
              count(a.id) FILTER (WHERE a.service_date = current_date)::text AS asignados_hoy
       FROM shifts s
       LEFT JOIN shift_assignments a ON a.shift_id = s.id
       WHERE s.site_id = $1
       GROUP BY s.id
       ORDER BY s.starts_at`,
      [siteId],
    );
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      weekdays: s.weekdays,
      entryToleranceMin: s.entry_tolerance_min,
      isActive: s.is_active,
      // Turno nocturno: la ventana cruza medianoche.
      crossesMidnight: s.starts_at > s.ends_at,
      assignedToday: Number(s.asignados_hoy),
    }));
  }

  async createShift(siteId: string, supervisorId: string, input: CreateShiftDto) {
    await this.ensureAssignedSite(siteId, supervisorId);
    if (input.startsAt === input.endsAt) {
      throw new BadRequestException('El turno no puede empezar y terminar a la misma hora');
    }
    const shiftId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO shifts (id, tenant_id, site_id, name, starts_at, ends_at,
                           weekdays, entry_tolerance_min)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6::smallint[], $7)`,
      [
        shiftId, siteId, input.name, input.startsAt, input.endsAt,
        input.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
        input.entryToleranceMin ?? 15,
      ],
    );
    return { id: shiftId, crossesMidnight: input.startsAt > input.endsAt };
  }

  async assignShift(shiftId: string, supervisorId: string, input: AssignShiftDto) {
    const turnos = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
      `SELECT site_id FROM shifts WHERE id = $1 AND is_active`,
      [shiftId],
    );
    const turno = turnos[0];
    if (!turno) throw new NotFoundException('El turno no existe o esta inactivo');
    await this.ensureAssignedSite(turno.site_id, supervisorId);

    const guardias = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
      `SELECT user_id FROM memberships WHERE user_id = $1 AND role_key = 'GUARDIA'`,
      [input.guardId],
    );
    if (!guardias.length) throw new NotFoundException('El guardia no existe en esta empresa');

    // Serializa las asignaciones del mismo guardia. Sin este lock, dos requests
    // simultaneos podrian hacer ambos el SELECT sin ver al otro y crear el
    // solapamiento justo entre la validacion y el INSERT.
    await this.tenantContext.manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [input.guardId],
    );

    const conflictos = await this.tenantContext.manager.query<Array<{
      assignment_id: string;
      shift_name: string;
      service_date: string;
    }>>(
      `WITH solicitada AS (
         SELECT
           (($2::date + objetivo.starts_at) AT TIME ZONE recinto.timezone) AS inicio,
           (($2::date + objetivo.ends_at
             + CASE WHEN objetivo.starts_at > objetivo.ends_at
                    THEN interval '1 day' ELSE interval '0 days' END
           ) AT TIME ZONE recinto.timezone) AS fin
         FROM shifts objetivo
         JOIN sites recinto ON recinto.id = objetivo.site_id
         WHERE objetivo.id = $1
       )
       SELECT a.id AS assignment_id, existente.name AS shift_name,
              a.service_date::text AS service_date
       FROM shift_assignments a
       JOIN shifts existente ON existente.id = a.shift_id
       JOIN sites recinto ON recinto.id = existente.site_id
       CROSS JOIN solicitada
       WHERE a.guard_id = $3
         AND tstzrange(
           (a.service_date + existente.starts_at) AT TIME ZONE recinto.timezone,
           (a.service_date + existente.ends_at
             + CASE WHEN existente.starts_at > existente.ends_at
                    THEN interval '1 day' ELSE interval '0 days' END
           ) AT TIME ZONE recinto.timezone,
           '[)'
         ) && tstzrange(solicitada.inicio, solicitada.fin, '[)')
       LIMIT 1`,
      [shiftId, input.serviceDate, input.guardId],
    );
    if (conflictos.length) {
      const conflicto = conflictos[0]!;
      throw new ConflictException(
        `El guardia ya tiene el turno ${conflicto.shift_name} el ${conflicto.service_date}; las ventanas se solapan`,
      );
    }

    const asignado = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO shift_assignments (tenant_id, shift_id, guard_id, service_date)
       VALUES (app_tenant_id(), $1, $2, $3)
       ON CONFLICT (tenant_id, shift_id, guard_id, service_date) DO NOTHING
       RETURNING id`,
      [shiftId, input.guardId, input.serviceDate],
    );
    if (!asignado.length) {
      throw new ConflictException('Ese guardia ya esta asignado a este turno en esa fecha');
    }
    return { id: asignado[0]!.id, shiftId, guardId: input.guardId, serviceDate: input.serviceDate };
  }

  /** Quien esta de servicio AHORA en el recinto: de aqui sale el escalamiento. */
  async onDutyNow(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      assignment_id: string; guard_id: string; guard_name: string;
      shift_name: string; started_at: Date; service_date: string;
    }>>(
      `SELECT a.id AS assignment_id, a.guard_id,
              (u.given_name || ' ' || u.family_name) AS guard_name,
              s.name AS shift_name, a.started_at, a.service_date
       FROM shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN users u ON u.id = a.guard_id
       WHERE s.site_id = $1 AND a.status = 'en_curso'
       ORDER BY a.started_at`,
      [siteId],
    );
    return rows.map((r) => ({
      assignmentId: r.assignment_id,
      guardId: r.guard_id,
      guardName: r.guard_name,
      shiftName: r.shift_name,
      startedAt: r.started_at,
      serviceDate: r.service_date,
    }));
  }

  /** La bandeja: novedades y panico juntos, misma consulta, misma auditoria. */
  async listEvents(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      criticality: string;
      text: string | null;
      guard_name: string;
      patrol_id: string | null;
      corrects_event_id: string | null;
      latitude: string | null;
      longitude: string | null;
      reported_at_server: Date;
    }>>(
      `SELECT e.id, e.criticality, e.text,
              (u.given_name || ' ' || u.family_name) AS guard_name,
              e.patrol_id, e.corrects_event_id, e.latitude, e.longitude,
              e.reported_at_server
       FROM field_events e
       JOIN users u ON u.id = e.guard_id
       WHERE e.site_id = $1
       ORDER BY e.reported_at_server DESC
       LIMIT 100`,
      [siteId],
    );
    return rows.map((e) => ({
      id: e.id,
      criticality: e.criticality,
      text: e.text,
      guardName: e.guard_name,
      patrolId: e.patrol_id,
      correctsEventId: e.corrects_event_id,
      latitude: e.latitude === null ? null : Number(e.latitude),
      longitude: e.longitude === null ? null : Number(e.longitude),
      reportedAt: e.reported_at_server,
    }));
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
