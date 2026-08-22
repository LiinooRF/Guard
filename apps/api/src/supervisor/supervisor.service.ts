import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { argon2id, hash } from 'argon2';
import { QueryFailedError } from 'typeorm';

import { normalizarUidNfc } from '../admin/uid-nfc';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { AuditService } from '../audit/audit.service';
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

/*
 * POR QUE LLEVAN `::text` Y `::boolean` EXPLICITOS, que parecen ruido:
 *
 * Un parametro ligado que solo aparece dentro de `IS NOT NULL` o como
 * condicion de un `CASE` no le da a PostgreSQL de donde deducir su tipo, y el
 * servidor responde `42P08 could not determine data type of parameter`. La
 * sentencia es valida escrita con literales —en `psql` pasa sin quejarse— y
 * revienta solo por el protocolo extendido, que es justamente el que usa la
 * aplicacion. Asignar una tarjeta NFC dio 500 en produccion por esto.
 *
 * Van como constante, y no dentro del metodo, porque
 * `parametros-tipados.integration.spec.ts` ejecuta ESTA MISMA cadena contra
 * PostgreSQL de verdad. Un mock no puede ver este error.
 */
export const SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR = `UPDATE users
   SET nfc_card_uid = $2::text,
       nfc_card_assigned_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE NULL END,
       nfc_pin_hash = CASE WHEN $3::boolean THEN $4::text ELSE nfc_pin_hash END,
       nfc_pin_updated_at = CASE
         WHEN $3::boolean AND $4::text IS NOT NULL THEN now()
         WHEN $3::boolean THEN NULL
         ELSE nfc_pin_updated_at
       END,
       updated_at = now()
   WHERE id = $1`;

@Injectable()
export class SupervisorService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    // Dar de baja un turno saca rondas del calendario: queda auditado con
    // nombre y propietario, como el resto de las acciones que cambian lo que
    // el guardia va a encontrar en terreno.
    private readonly audit: AuditService,
  ) {}

  /** Nombre legible del actor para el registro de auditoria. */
  private async etiquetaDe(actorId: string): Promise<string> {
    const filas = await this.tenantContext.manager.query<Array<{ label: string }>>(
      `SELECT (given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
      [actorId],
    );
    return filas[0]?.label ?? 'Supervisor';
  }

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

  async liveBoard(supervisorId: string) {
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      site_id: string;
      site_name: string;
      route_name: string;
      guard_id: string;
      guard_name: string;
      status: string;
      scheduled_start_at: Date;
      scheduled_end_at: Date;
      started_at: Date | null;
      expected_count: number;
      scanned_count: number;
      last_checkpoint_name: string | null;
      last_scan_at: Date | null;
      latitude: string | null;
      longitude: string | null;
      position_at: Date | null;
      accuracy_m: string | null;
    }>>(
      `SELECT p.id, p.site_id, si.name AS site_name, r.name AS route_name,
              p.guard_id, trim(u.given_name || ' ' || u.family_name) AS guard_name,
              p.status, p.scheduled_start_at, p.scheduled_end_at, p.started_at,
              jsonb_array_length(p.expected_checkpoint_ids)::int AS expected_count,
              COALESCE(progress.scanned_count, 0)::int AS scanned_count,
              ultimo.checkpoint_name AS last_checkpoint_name,
              ultimo.scanned_at_server AS last_scan_at,
              posicion.latitude, posicion.longitude,
              posicion.recorded_at_device AS position_at, posicion.accuracy_m
       FROM patrols p
       JOIN supervisor_sites scope
         ON scope.site_id = p.site_id AND scope.supervisor_id = $1
       JOIN sites si ON si.id = p.site_id
       JOIN routes r ON r.id = p.route_id
       JOIN users u ON u.id = p.guard_id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT s.checkpoint_id)::int AS scanned_count
         FROM scans s WHERE s.patrol_id = p.id
       ) progress ON true
       LEFT JOIN LATERAL (
         SELECT c.name AS checkpoint_name, s.scanned_at_server
         FROM scans s JOIN checkpoints c ON c.id = s.checkpoint_id
         WHERE s.patrol_id = p.id ORDER BY s.scanned_at_server DESC LIMIT 1
       ) ultimo ON true
       LEFT JOIN LATERAL (
         SELECT pt.latitude, pt.longitude, pt.recorded_at_device, pt.accuracy_m
         FROM patrol_tracks pt WHERE pt.patrol_id = p.id
         ORDER BY pt.recorded_at_device DESC LIMIT 1
       ) posicion ON true
       WHERE p.status IN ('pendiente', 'en_curso')
         AND p.scheduled_end_at >= now() - interval '12 hours'
       ORDER BY CASE p.status WHEN 'en_curso' THEN 0 ELSE 1 END, p.scheduled_start_at
       LIMIT 100`,
      [supervisorId],
    );

    const rulesBySite = new Map<string, Awaited<ReturnType<RulesService['effective']>>>();
    for (const siteId of new Set(rows.map((row) => row.site_id))) {
      rulesBySite.set(siteId, await this.rules.effective({ siteId }));
    }

    return {
      refreshedAt: new Date().toISOString(),
      pollAfterMs: 5_000,
      patrols: rows.map((row) => {
        // gpsTrackingEnabled y NO gpsSharingMandatory: el segundo decide
        // obligatorio vs OPCIONAL, no encendido vs apagado. Leerlo mal
        // aca esconde en el tablero a guardias que SI estan compartiendo
        // ubicacion, que es justo lo que el monitoreo en vivo debe mostrar.
        const gpsEnabled = rulesBySite.get(row.site_id)?.gpsTrackingEnabled ?? false;
        return {
          id: row.id,
          siteId: row.site_id,
          siteName: row.site_name,
          routeName: row.route_name,
          guardId: row.guard_id,
          guardName: row.guard_name,
          status: row.status,
          scheduledStartAt: row.scheduled_start_at,
          scheduledEndAt: row.scheduled_end_at,
          startedAt: row.started_at,
          expectedCheckpoints: row.expected_count,
          scannedCheckpoints: row.scanned_count,
          progressPct: row.expected_count
            ? Math.min(100, Math.round((row.scanned_count / row.expected_count) * 100))
            : 0,
          lastCheckpointName: row.last_checkpoint_name,
          lastScanAt: row.last_scan_at,
          gpsEnabled,
          position: gpsEnabled && row.latitude !== null && row.longitude !== null
            ? {
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                recordedAt: row.position_at,
                accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
              }
            : null,
        };
      }),
    };
  }

  /** Catálogo mínimo del editor; el JOIN de alcance evita enumerar recintos ajenos. */
  async routeEditorSites(supervisorId: string) {
    const rows = await this.tenantContext.manager.query<Array<{
      id: string; name: string; branch_name: string; address: string;
      latitude: number | null; longitude: number | null;
      checkpoints: Array<{
        id: string; name: string; latitude: number | null; longitude: number | null;
        requiresPhoto: boolean | null; suggestedOrder: number;
      }>;
    }>>(
      `SELECT s.id, s.name, s.branch_name, s.address, s.latitude, s.longitude,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'latitude', c.latitude,
                'longitude', c.longitude, 'requiresPhoto', c.requires_photo,
                'suggestedOrder', c.suggested_order
              ) ORDER BY c.suggested_order, c.name)
              FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS checkpoints
       FROM supervisor_sites scope
       JOIN sites s ON s.id = scope.site_id AND s.is_active
       LEFT JOIN checkpoints c ON c.site_id = s.id AND c.is_active
       WHERE scope.supervisor_id = $1
       GROUP BY s.id ORDER BY s.branch_name, s.name`,
      [supervisorId],
    );
    return rows.map((row) => ({
      id: row.id, name: row.name, branchName: row.branch_name, address: row.address,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      checkpoints: row.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        latitude: checkpoint.latitude === null ? null : Number(checkpoint.latitude),
        longitude: checkpoint.longitude === null ? null : Number(checkpoint.longitude),
      })),
    }));
  }

  /**
   * Los recintos que el supervisor tiene asignados.
   *
   * Faltaba: el supervisor podia consultar CADA recinto por id pero no tenia
   * como saber cuales son los suyos, y `/admin/sites` es de ADMIN. Cualquier
   * pantalla que empiece por "elige un recinto" necesitaba esto.
   *
   * No lleva ensureAssignedSite porque es justamente la consulta que RESUELVE
   * que recintos son suyos: el JOIN con supervisor_sites es el filtro.
   */
  async listAssignedSites(supervisorId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        id: string;
        name: string;
        branch_name: string;
        // NOT NULL en la migracion 1722524400000-CreateDemoDomain.
        address: string;
        timezone: string;
        latitude: string | null;
        longitude: string | null;
      }>
    >(
      `SELECT s.id, s.name, s.branch_name, s.address, s.timezone, s.latitude, s.longitude
       FROM supervisor_sites ss
       JOIN sites s ON s.tenant_id = ss.tenant_id AND s.id = ss.site_id
       WHERE ss.supervisor_id = $1 AND s.is_active
       ORDER BY s.branch_name, s.name`,
      [supervisorId],
    );
    return filas.map((f) => ({
      id: f.id,
      name: f.name,
      branchName: f.branch_name,
      address: f.address,
      timezone: f.timezone,
      // numeric llega como texto desde el driver; el mapa necesita numeros.
      latitude: f.latitude === null ? null : Number(f.latitude),
      longitude: f.longitude === null ? null : Number(f.longitude),
    }));
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

  async listGuards(siteId: string, supervisorId: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      given_name: string;
      family_name: string;
      nfc_card_uid: string | null;
      tiene_pin: boolean;
    }>>(
      // Se devuelve SI tiene PIN, nunca el hash: el supervisor necesita saber
      // a quien le falta configurarlo, no leer el secreto de nadie.
      `SELECT u.id, u.given_name, u.family_name, u.nfc_card_uid,
              (u.nfc_pin_hash IS NOT NULL) AS tiene_pin
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.role_key = 'GUARDIA' AND u.is_active
       ORDER BY u.given_name, u.family_name`,
    );
    return rows.map((guard) => ({
      id: guard.id,
      name: `${guard.given_name} ${guard.family_name}`.trim(),
      nfcCardUid: guard.nfc_card_uid ?? null,
      tienePin: guard.tiene_pin === true,
    }));
  }

  async assignGuardNfcCard(
    guardId: string,
    supervisorId: string,
    input: { nfcCardUid?: string | null; nfcPin?: string | null },
  ) {
    const guards = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT u.id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.role_key = 'GUARDIA' AND u.is_active`,
      [guardId],
    );
    if (!guards.length) throw new NotFoundException('El guardia no existe o esta inactivo');

    const supervisorSites = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
      `SELECT site_id FROM supervisor_sites WHERE supervisor_id = $1 LIMIT 1`,
      [supervisorId],
    );
    if (!supervisorSites.length) {
      throw new ForbiddenException('No tienes recintos asignados para gestionar guardias');
    }

    const normalizedUid = input.nfcCardUid ? normalizarUidNfc(input.nfcCardUid) : null;

    /*
     * El PIN es OPCIONAL y de segundo factor: la tarjeta se clona, el PIN no
     * viaja en ella. Tres estados distintos, y la diferencia importa:
     *
     * - `undefined`  -> no se toca. Asignar una tarjeta no puede borrar en
     *                   silencio el PIN que el guardia ya tenia.
     * - `null` o ''  -> se QUITA. La empresa que prioriza velocidad en la
     *                   garita vuelve al login de solo tarjeta.
     * - '1234'       -> se guarda HASHEADO, nunca en claro.
     */
    const tocaElPin = input.nfcPin !== undefined;
    const pinHash = input.nfcPin
      ? await hash(input.nfcPin, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 })
      : null;

    try {
      await this.tenantContext.manager.query(
        SQL_ASIGNAR_TARJETA_NFC_SUPERVISOR,
        [guardId, normalizedUid, tocaElPin, pinHash],
      );
      // NUNCA se devuelve el hash ni el PIN: solo si quedo configurado o no.
      return { id: guardId, nfcCardUid: normalizedUid, tienePin: tocaElPin ? pinHash !== null : undefined };
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
        throw new ConflictException('La tarjeta NFC ya esta asignada a otro usuario');
      }
      throw error;
    }
  }

  async weeklySchedule(siteId: string, supervisorId: string, from: string) {
    await this.ensureAssignedSite(siteId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      shift_id: string;
      shift_name: string;
      starts_at: string;
      ends_at: string;
      service_date: string;
      guard_id: string;
      guard_name: string;
      status: string;
      route_id: string | null;
      route_name: string | null;
    }>>(
      `SELECT a.id, s.id AS shift_id, s.name AS shift_name, s.starts_at, s.ends_at,
              a.service_date::text AS service_date, a.guard_id,
              trim(u.given_name || ' ' || u.family_name) AS guard_name, a.status,
              p.route_id, r.name AS route_name
       FROM shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN users u ON u.id = a.guard_id
       LEFT JOIN LATERAL (
         SELECT sp.route_id FROM shift_patterns sp
         WHERE sp.shift_id = s.id AND sp.is_active
         ORDER BY sp.created_at, sp.route_id LIMIT 1
       ) p ON true
       LEFT JOIN routes r ON r.id = p.route_id
       WHERE s.site_id = $1
         AND a.service_date >= $2::date
         AND a.service_date < $2::date + 7
       ORDER BY a.service_date, s.starts_at, guard_name`,
      [siteId, from],
    );
    return rows.map((row) => ({
      id: row.id,
      shiftId: row.shift_id,
      shiftName: row.shift_name,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      serviceDate: row.service_date,
      guardId: row.guard_id,
      guardName: row.guard_name,
      status: row.status,
      routeId: row.route_id,
      routeName: row.route_name,
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

  /**
   * Retira un turno del calendario, o lo vuelve a poner.
   *
   * Se da de BAJA, no se borra, por lo mismo que las rutas: un turno tiene
   * asignaciones, y esas asignaciones tienen rondas con sus escaneos, fotos e
   * informes. Borrarlo dejaria ese historial colgando de un turno que ya no
   * existe, y los informes de meses pasados no podrian decir a que turno
   * pertenecio cada ronda.
   *
   * Dado de baja deja de generar rondas nuevas —el planificador exige
   * `s.is_active`— y desaparece de las listas para asignar, que es lo que se
   * pide cuando alguien dice "eliminar el turno".
   */
  async cambiarActivoTurno(shiftId: string, supervisorId: string, activo: boolean) {
    const filas = await this.tenantContext.manager.query<
      Array<{ id: string; name: string; site_id: string }>
    >(
      `UPDATE shifts s
       SET is_active = $2
       WHERE s.id = $1
         AND EXISTS (
           SELECT 1 FROM supervisor_sites ss
           WHERE ss.site_id = s.site_id AND ss.supervisor_id = $3
         )
       RETURNING s.id, s.name, s.site_id`,
      [shiftId, activo, supervisorId],
    );
    if (!filas[0]) {
      throw new NotFoundException('No encontramos ese turno en tus recintos');
    }

    // Cuantas asignaciones FUTURAS quedan colgando. No se tocan —pueden estar
    // trabajandose hoy— pero el supervisor tiene que enterarse de que siguen
    // ahi, o va a creer que dar de baja el turno vacio el calendario.
    const pendientes = await this.tenantContext.manager.query<Array<{ total: string }>>(
      `SELECT count(*)::text AS total FROM shift_assignments
       WHERE shift_id = $1 AND service_date >= CURRENT_DATE`,
      [shiftId],
    );

    await this.audit.record({
      actorId: supervisorId,
      actorLabel: await this.etiquetaDe(supervisorId),
      action: activo ? 'turno.reactivado' : 'turno.dado_de_baja',
      entityType: 'shift',
      entityId: shiftId,
      summary: `${activo ? 'Reactivado' : 'Dado de baja'} el turno "${filas[0].name}"`,
    });

    return {
      id: filas[0].id,
      isActive: activo,
      /** Asignaciones de hoy en adelante que siguen en el calendario. */
      pendingAssignments: Number(pendientes[0]?.total ?? 0),
    };
  }

  async assignShift(shiftId: string, supervisorId: string, input: AssignShiftDto) {
    const turnos = await this.tenantContext.manager.query<Array<{
      site_id: string;
      weekday_ok: boolean;
    }>>(
      `SELECT site_id, extract(dow FROM $2::date)::int = ANY(weekdays) AS weekday_ok
       FROM shifts WHERE id = $1 AND is_active`,
      [shiftId, input.serviceDate],
    );
    const turno = turnos[0];
    if (!turno) throw new NotFoundException('El turno no existe o esta inactivo');
    if (turno.weekday_ok === false) {
      throw new BadRequestException('El turno no aplica en ese dia de la semana');
    }
    await this.ensureAssignedSite(turno.site_id, supervisorId);

    const guardias = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
      `SELECT user_id FROM memberships WHERE user_id = $1 AND role_key = 'GUARDIA'`,
      [input.guardId],
    );
    if (!guardias.length) throw new NotFoundException('El guardia no existe en esta empresa');

    await this.assertNoOverlap(shiftId, input.guardId, input.serviceDate, supervisorId);

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

  async checkShiftConflict(shiftId: string, supervisorId: string, input: AssignShiftDto) {
    const shifts = await this.tenantContext.manager.query<Array<{
      site_id: string;
      weekday_ok: boolean;
    }>>(
      `SELECT site_id, extract(dow FROM $2::date)::int = ANY(weekdays) AS weekday_ok
       FROM shifts WHERE id = $1 AND is_active`,
      [shiftId, input.serviceDate],
    );
    if (!shifts[0]) throw new NotFoundException('El turno no existe o esta inactivo');
    if (shifts[0].weekday_ok === false) {
      throw new BadRequestException('El turno no aplica en ese dia de la semana');
    }
    await this.ensureAssignedSite(shifts[0].site_id, supervisorId);
    const guards = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.role_key = 'GUARDIA' AND u.is_active`,
      [input.guardId],
    );
    if (!guards.length) throw new NotFoundException('El guardia no existe o esta inactivo');
    try {
      await this.assertNoOverlap(shiftId, input.guardId, input.serviceDate, supervisorId);
      return { conflict: false };
    } catch (error) {
      if (error instanceof ConflictException) {
        return { conflict: true, message: error.message };
      }
      throw error;
    }
  }

  async reassignShift(assignmentId: string, supervisorId: string, guardId: string) {
    const assignments = await this.tenantContext.manager.query<Array<{
      shift_id: string;
      site_id: string;
      service_date: string;
      status: string;
    }>>(
      `SELECT a.shift_id, s.site_id, a.service_date::text AS service_date, a.status
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
       WHERE a.id = $1`,
      [assignmentId],
    );
    const assignment = assignments[0];
    if (!assignment) throw new NotFoundException('La asignacion no existe');
    await this.ensureAssignedSite(assignment.site_id, supervisorId);
    if (assignment.status !== 'asignado') {
      throw new ConflictException('Solo se puede reasignar un turno que aun no ha comenzado');
    }
    const guards = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.role_key = 'GUARDIA' AND u.is_active`,
      [guardId],
    );
    if (!guards.length) throw new NotFoundException('El guardia no existe o esta inactivo');
    await this.assertNoOverlap(
      assignment.shift_id,
      guardId,
      assignment.service_date,
      supervisorId,
      assignmentId,
    );
    await this.tenantContext.manager.query(
      `UPDATE shift_assignments SET guard_id = $2 WHERE id = $1`,
      [assignmentId, guardId],
    );
    await this.tenantContext.manager.query(
      `UPDATE patrols SET guard_id = $2 WHERE shift_assignment_id = $1 AND status = 'pendiente'`,
      [assignmentId, guardId],
    );
    return { id: assignmentId, guardId };
  }

  private async assertNoOverlap(
    shiftId: string,
    guardId: string,
    serviceDate: string,
    supervisorId: string,
    excludeAssignmentId?: string,
  ) {
    // Un lock por guardia tambien cubre turnos nocturnos en fechas adyacentes.
    await this.tenantContext.manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [guardId],
    );
    const conflictos = await this.tenantContext.manager.query<Array<{
      assignment_id: string;
      shift_name: string;
      service_date: string;
      visible_to_supervisor: boolean;
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
              a.service_date::text AS service_date,
              EXISTS (
                SELECT 1 FROM supervisor_sites acceso
                WHERE acceso.supervisor_id = $5
                  AND acceso.site_id = existente.site_id
              ) AS visible_to_supervisor
       FROM shift_assignments a
       JOIN shifts existente ON existente.id = a.shift_id
       JOIN sites recinto ON recinto.id = existente.site_id
       CROSS JOIN solicitada
       WHERE a.guard_id = $3
         AND ($4::uuid IS NULL OR a.id <> $4::uuid)
         AND tstzrange(
           (a.service_date + existente.starts_at) AT TIME ZONE recinto.timezone,
           (a.service_date + existente.ends_at
             + CASE WHEN existente.starts_at > existente.ends_at
                    THEN interval '1 day' ELSE interval '0 days' END
           ) AT TIME ZONE recinto.timezone,
           '[)'
         ) && tstzrange(solicitada.inicio, solicitada.fin, '[)')
       LIMIT 1`,
      [shiftId, serviceDate, guardId, excludeAssignmentId ?? null, supervisorId],
    );
    if (conflictos.length) {
      const conflicto = conflictos[0]!;
      throw new ConflictException(conflicto.visible_to_supervisor
        ? `El guardia ya tiene el turno ${conflicto.shift_name} el ${conflicto.service_date}; las ventanas se solapan`
        : 'El guardia ya tiene un turno asignado en ese horario; las ventanas se solapan');
    }

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
