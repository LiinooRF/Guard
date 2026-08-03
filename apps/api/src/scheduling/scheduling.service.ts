import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import type { RouteOrderMode } from '../supervisor/dto/create-route.dto';
import type { ReplaceShiftPatternsDto } from './dto/shift-pattern.dto';

/**
 * Quien dispara la generacion. No es un adorno: el SUPERVISOR esta limitado a
 * SUS recintos y la generacion sin recinto explicito recorreria todo el tenant.
 * El tipo obliga a decidirlo en el llamador en vez de dejar un `supervisorId`
 * opcional que, olvidado, abre el alcance en silencio.
 */
export type Ejecutor =
  | { readonly kind: 'supervisor'; readonly supervisorId: string }
  | { readonly kind: 'sistema' };

interface SlotRow {
  assignment_id: string;
  guard_id: string;
  guard_name: string;
  shift_id: string;
  shift_name: string;
  site_id: string;
  site_name: string;
  timezone: string;
  route_id: string | null;
  route_name: string | null;
  order_mode: RouteOrderMode | null;
  requested_count: number | null;
  planned_count: number | null;
  seq: number | null;
  window_start: Date | null;
  window_end: Date | null;
  window_elapsed: boolean;
  already_exists: boolean;
  skip_reason: string | null;
}

interface PuntoSnapshot {
  checkpoint_id: string;
  is_closing_point: boolean;
  is_anchor: boolean;
}

const YA_GENERADA = 'la ronda ya estaba generada';
const VENTANA_VENCIDA = 'la ventana de la ronda ya vencio';

/** Cuantas rondas pedia el patron, cuando la separacion minima obligo a bajar. */
function recorteDelPatron(fila: SlotRow): number | null {
  const { requested_count: pedidas, planned_count: programadas } = fila;
  if (pedidas === null || programadas === null || programadas >= pedidas) return null;
  return pedidas;
}

/**
 * Plan del dia: que rondas corresponden y en que ventana, sin escribir nada.
 *
 * El calculo de horarios ocurre entero en SQL, y eso es deliberado.
 *
 * El turno se guarda como hora local ('22:00'..'06:00') y el instante real
 * depende de la zona horaria DEL RECINTO (sites.timezone), que puede diferir del
 * servidor, del navegador del supervisor y del telefono del guardia. Hacerlo en
 * JavaScript exigiria convertir esa hora local a UTC, y la unica forma de
 * hacerlo sin la base de datos de husos horarios es aplicar un offset fijo
 * (-04:00). Ese offset esta MAL la mitad del año: con horario de verano el turno
 * de las 22:00 quedaria agendado a las 21:00 o a las 23:00 reales. En Chile
 * ademas las fechas del cambio de hora se mueven por decreto, asi que ni
 * siquiera son estables entre años; una tabla de offsets en el codigo envejece
 * sola. `timestamp AT TIME ZONE 'America/Santiago'` resuelve el offset que regia
 * ESE dia usando la tzdata del motor, que se actualiza con el sistema.
 *
 * Del mismo orden es el cruce de medianoche: el `+ INTERVAL '1 day'` se aplica
 * al timestamp SIN zona, antes de convertir, para que signifique "las 06:00 del
 * dia calendario siguiente" y no "24 horas despues". En la noche del cambio de
 * hora eso son 23 o 25 horas reales, que es exactamente lo que trabaja el
 * guardia: el turno se ancla a las horas del reloj de la pared, no a una
 * duracion fija.
 *
 * Consecuencia buscada: la ronda de las 02:00 del turno del viernes pertenece al
 * service_date del VIERNES aunque ocurra el sabado. El turno es el contenedor.
 */
const SQL_PLAN = `
  WITH turno AS (
    SELECT
      a.tenant_id,
      a.id                                   AS assignment_id,
      a.guard_id,
      (u.given_name || ' ' || u.family_name) AS guard_name,
      a.status                               AS assignment_status,
      s.id                                   AS shift_id,
      s.name                                 AS shift_name,
      s.is_active                            AS shift_active,
      s.site_id,
      si.name                                AS site_name,
      si.timezone,
      (EXTRACT(DOW FROM $1::date)::smallint = ANY (s.weekdays)) AS weekday_ok,
      (($1::date + s.starts_at) AT TIME ZONE si.timezone) AS shift_start,
      ((($1::date + s.ends_at)
        + CASE WHEN s.ends_at <= s.starts_at THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END
       ) AT TIME ZONE si.timezone) AS shift_end
    FROM shift_assignments a
    JOIN shifts s ON s.tenant_id = a.tenant_id AND s.id = a.shift_id
    JOIN sites si ON si.tenant_id = s.tenant_id AND si.id = s.site_id
    JOIN users u  ON u.id = a.guard_id
    WHERE a.service_date = $1::date
      AND ($2::uuid IS NULL OR s.site_id = $2::uuid)
      AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM supervisor_sites ss
            WHERE ss.site_id = s.site_id AND ss.supervisor_id = $3::uuid))
  ),
  patron AS (
    SELECT
      t.*,
      p.route_id,
      r.name       AS route_name,
      r.order_mode,
      p.patrols_per_shift::int AS requested_count,
      -- Si el turno no da para las rondas pedidas respetando la separacion
      -- minima, MANDA la separacion y se generan las que caben. Programar 12
      -- rondas de 40 minutos en un turno que necesita 45 no las hace posibles:
      -- las inventa, y el guardia arranca la noche con incumplimiento asegurado.
      CASE
        WHEN p.min_gap_minutes IS NULL OR p.min_gap_minutes <= 0 THEN p.patrols_per_shift::int
        ELSE LEAST(
          p.patrols_per_shift::int,
          GREATEST(1, FLOOR(
            EXTRACT(EPOCH FROM (t.shift_end - t.shift_start)) / 60.0 / p.min_gap_minutes
          )::int)
        )
      END AS planned_count,
      CASE
        WHEN NOT t.shift_active              THEN 'el turno esta inactivo'
        WHEN t.assignment_status = 'ausente' THEN 'el guardia esta marcado ausente'
        WHEN NOT t.weekday_ok                THEN 'la fecha no esta en la recurrencia del turno'
        WHEN p.shift_id IS NULL              THEN 'el turno no tiene patron de rondas activo'
        WHEN r.id IS NULL                    THEN 'la ruta del patron esta inactiva'
        WHEN (
          SELECT count(*) FROM route_checkpoints rc
          WHERE rc.tenant_id = t.tenant_id AND rc.route_id = p.route_id
        ) < 2                                THEN 'la ruta no tiene una secuencia valida de puntos'
      END AS skip_reason
    FROM turno t
    LEFT JOIN shift_patterns p
      ON p.tenant_id = t.tenant_id AND p.shift_id = t.shift_id AND p.is_active
    LEFT JOIN routes r
      ON r.tenant_id = p.tenant_id AND r.id = p.route_id AND r.is_active
  ),
  slot AS (
    SELECT
      pt.*,
      g.seq::int AS seq,
      (pt.shift_start + (pt.shift_end - pt.shift_start) * (g.seq - 1) / pt.planned_count)
        AS window_start,
      (pt.shift_start + (pt.shift_end - pt.shift_start) * g.seq / pt.planned_count)
        AS window_end
    FROM patron pt
    -- LEFT: el turno descartado igual devuelve su fila, con el motivo. Un
    -- "no se genero nada" sin explicacion es lo que hace que nadie confie en
    -- la programacion automatica.
    LEFT JOIN LATERAL generate_series(1, pt.planned_count) AS g(seq)
      ON pt.skip_reason IS NULL
  )
  SELECT
    sl.assignment_id, sl.guard_id, sl.guard_name,
    sl.shift_id, sl.shift_name,
    sl.site_id, sl.site_name, sl.timezone,
    sl.route_id, sl.route_name, sl.order_mode,
    sl.requested_count, sl.planned_count,
    sl.seq, sl.window_start, sl.window_end, sl.skip_reason,
    (sl.window_end IS NOT NULL AND sl.window_end <= now()) AS window_elapsed,
    EXISTS (
      SELECT 1 FROM patrols ex
      WHERE ex.shift_assignment_id = sl.assignment_id
        AND ex.route_id = sl.route_id
        AND ex.schedule_seq = sl.seq
    ) AS already_exists
  FROM slot sl
  ORDER BY sl.site_name, sl.shift_name, sl.guard_name, sl.route_name, sl.seq
`;

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly supervisor: SupervisorService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lo que la interfaz muestra antes de confirmar. No escribe nada y consulta
   * exactamente el mismo plan que usa generateForDate: si difirieran, el
   * supervisor confirmaria una cosa y ocurriria otra.
   */
  async previewDay(siteId: string, serviceDate: string, supervisorId: string) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    const filas = await this.planificar(serviceDate, siteId, supervisorId);

    const planned = filas
      .filter((f) => f.skip_reason === null)
      .map((f) => ({
        assignmentId: f.assignment_id,
        guardId: f.guard_id,
        guardName: f.guard_name,
        shiftId: f.shift_id,
        shiftName: f.shift_name,
        routeId: f.route_id,
        routeName: f.route_name,
        sequence: f.seq,
        ofTotal: f.planned_count,
        windowStart: f.window_start,
        windowEnd: f.window_end,
        alreadyExists: f.already_exists,
        windowElapsed: f.window_elapsed,
        // Cuando la separacion minima recorto las rondas del patron, se dice.
        adjustedFromRequested: recorteDelPatron(f),
      }));

    const skipped = filas
      .filter((f) => f.skip_reason !== null)
      .map((f) => ({
        assignmentId: f.assignment_id,
        shiftId: f.shift_id,
        shiftName: f.shift_name,
        guardName: f.guard_name,
        reason: f.skip_reason,
      }));

    return {
      siteId,
      serviceDate,
      timezone: filas[0]?.timezone ?? null,
      planned,
      skipped,
      totals: {
        toGenerate: planned.filter((p) => !p.alreadyExists && !p.windowElapsed).length,
        alreadyExisting: planned.filter((p) => p.alreadyExists).length,
        elapsed: planned.filter((p) => !p.alreadyExists && p.windowElapsed).length,
        skipped: skipped.length,
      },
    };
  }

  /**
   * Crea las rondas pendientes del dia segun los patrones de cada turno.
   *
   * Es IDEMPOTENTE: correrlo dos veces no duplica. El chequeo previo
   * (already_exists) evita el trabajo, pero quien garantiza la propiedad es el
   * indice unico patrols_generated_slot_idx mas el ON CONFLICT DO NOTHING —
   * entre la consulta y el INSERT cabe otra corrida simultanea, y ahi el
   * chequeo previo solo no alcanza.
   */
  async generateForDate(input: { serviceDate: string; siteId?: string }, ejecutor: Ejecutor) {
    const supervisorId = ejecutor.kind === 'supervisor' ? ejecutor.supervisorId : null;
    if (supervisorId && input.siteId) {
      // Con recinto explicito conviene el 403 antes que un plan vacio: "no
      // tienes este recinto" y "hoy no hay nada que generar" son distintos.
      await this.supervisor.ensureAssignedSite(input.siteId, supervisorId);
    }

    const filas = await this.planificar(input.serviceDate, input.siteId ?? null, supervisorId);
    const rutas = await this.secuenciasDeRuta(
      [...new Set(filas.filter((f) => f.route_id !== null).map((f) => f.route_id as string))],
    );
    const reglas = await this.rules.effective();

    let generated = 0;
    const motivos = new Map<string, number>();
    const omitir = (motivo: string) => motivos.set(motivo, (motivos.get(motivo) ?? 0) + 1);

    for (const fila of filas) {
      if (fila.skip_reason !== null) {
        omitir(fila.skip_reason);
        continue;
      }
      if (fila.already_exists) {
        omitir(YA_GENERADA);
        continue;
      }
      // Una ronda cuya ventana ya cerro nace incumplida y ensucia la estadistica
      // del recinto sin que nadie haya podido hacer nada.
      if (fila.window_elapsed) {
        omitir(VENTANA_VENCIDA);
        continue;
      }

      const routeId = fila.route_id;
      const puntos = routeId === null ? [] : (rutas.get(routeId) ?? []);
      if (routeId === null || puntos.length < 2 || !fila.window_start || !fila.window_end) {
        omitir('la ruta no tiene una secuencia valida de puntos');
        continue;
      }

      // Mismo criterio que supervisor.createPatrol: la regla del tenant fuerza
      // el sorteo sobre rutas 'fijo' y el modo de la ruta refina. El sorteo se
      // hace POR RONDA: cuatro rondas de la misma noche con el mismo orden
      // serian tan predecibles como una sola.
      let modo: RouteOrderMode = fila.order_mode ?? 'fijo';
      if (modo === 'fijo' && reglas.randomizeRouteOrder) modo = 'aleatorio';
      const orden = this.supervisor.sortearOrden(puntos, modo);

      const insertada = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `INSERT INTO patrols (
           id, tenant_id, site_id, route_id, guard_id,
           scheduled_start_at, scheduled_end_at, expected_checkpoint_ids,
           shift_assignment_id, schedule_seq
         ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (tenant_id, shift_assignment_id, route_id, schedule_seq)
           WHERE schedule_seq IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          fila.site_id,
          routeId,
          fila.guard_id,
          fila.window_start,
          fila.window_end,
          JSON.stringify(orden),
          fila.assignment_id,
          fila.seq,
        ],
      );

      if (insertada.length) generated += 1;
      else omitir(YA_GENERADA);
    }

    const skipped = [...motivos.values()].reduce((total, n) => total + n, 0);
    const corridas = await this.tenantContext.manager.query<Array<{ id: string; ran_at: Date }>>(
      `INSERT INTO schedule_runs (tenant_id, site_id, service_date, generated, skipped, ran_by)
       VALUES (app_tenant_id(), $1, $2::date, $3, $4, $5)
       RETURNING id, ran_at`,
      [input.siteId ?? null, input.serviceDate, generated, skipped, supervisorId],
    );

    if (supervisorId) await this.registrarAuditoria(supervisorId, input, generated, skipped);

    // Sin nombres ni identificadores de personas en el log (ver CLAUDE.md).
    this.logger.log(
      JSON.stringify({
        event: 'rondas_generadas',
        service_date: input.serviceDate,
        generated,
        skipped,
      }),
    );

    return {
      runId: corridas[0]?.id ?? null,
      ranAt: corridas[0]?.ran_at ?? null,
      serviceDate: input.serviceDate,
      siteId: input.siteId ?? null,
      generated,
      skipped,
      skippedByReason: Object.fromEntries(motivos),
    };
  }

  // ------------------------------------------------------- patrones (#132)

  async listPatterns(shiftId: string, supervisorId: string) {
    await this.ensureShiftAssigned(shiftId, supervisorId);
    const rows = await this.tenantContext.manager.query<Array<{
      route_id: string;
      route_name: string;
      patrols_per_shift: number;
      min_gap_minutes: number;
      is_active: boolean;
    }>>(
      `SELECT p.route_id, r.name AS route_name, p.patrols_per_shift,
              p.min_gap_minutes, p.is_active
       FROM shift_patterns p
       JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
       WHERE p.shift_id = $1
       ORDER BY r.name`,
      [shiftId],
    );
    return rows.map((p) => ({
      routeId: p.route_id,
      routeName: p.route_name,
      patrolsPerShift: p.patrols_per_shift,
      minGapMinutes: p.min_gap_minutes,
      isActive: p.is_active,
    }));
  }

  /** Reemplaza el set completo de patrones del turno. */
  async replacePatterns(shiftId: string, supervisorId: string, input: ReplaceShiftPatternsDto) {
    const siteId = await this.ensureShiftAssigned(shiftId, supervisorId);

    const rutas = input.patterns.map((p) => p.routeId);
    if (new Set(rutas).size !== rutas.length) {
      throw new BadRequestException('Una ruta no puede repetirse en el patron del turno');
    }

    await this.tenantContext.manager.query(`DELETE FROM shift_patterns WHERE shift_id = $1`, [
      shiftId,
    ]);
    for (const patron of input.patterns) {
      const insertado = await this.tenantContext.manager.query<Array<{ route_id: string }>>(
        `INSERT INTO shift_patterns (
           tenant_id, shift_id, route_id, patrols_per_shift, min_gap_minutes, is_active
         )
         SELECT app_tenant_id(), $1, r.id, $3, $4, $5
         FROM routes r
         WHERE r.id = $2 AND r.site_id = $6
         RETURNING route_id`,
        [
          shiftId,
          patron.routeId,
          patron.patrolsPerShift,
          patron.minGapMinutes,
          patron.isActive ?? true,
          siteId,
        ],
      );
      if (!insertado.length) {
        // Una ruta de OTRO recinto programada en este turno mandaria al guardia
        // a puntos que no existen donde esta. La transaccion del request se
        // revierte completa.
        throw new BadRequestException(
          `La ruta ${patron.routeId} no pertenece al recinto de este turno`,
        );
      }
    }
    return this.listPatterns(shiftId, supervisorId);
  }

  // ------------------------------------------------------------- internos

  private planificar(serviceDate: string, siteId: string | null, supervisorId: string | null) {
    return this.tenantContext.manager.query<SlotRow[]>(SQL_PLAN, [
      serviceDate,
      siteId,
      supervisorId,
    ]);
  }

  /** Snapshot de puntos por ruta, en el orden de la secuencia definida. */
  private async secuenciasDeRuta(routeIds: string[]): Promise<Map<string, PuntoSnapshot[]>> {
    const porRuta = new Map<string, PuntoSnapshot[]>();
    if (!routeIds.length) return porRuta;

    const rows = await this.tenantContext.manager.query<
      Array<PuntoSnapshot & { route_id: string }>
    >(
      `SELECT route_id, checkpoint_id, is_closing_point, is_anchor
       FROM route_checkpoints
       WHERE route_id = ANY($1::uuid[])
       ORDER BY route_id, position`,
      [routeIds],
    );
    for (const row of rows) {
      const lista = porRuta.get(row.route_id) ?? [];
      lista.push({
        checkpoint_id: row.checkpoint_id,
        is_closing_point: row.is_closing_point,
        is_anchor: row.is_anchor,
      });
      porRuta.set(row.route_id, lista);
    }
    return porRuta;
  }

  /** El turno pertenece a un recinto y el supervisor solo maneja los suyos. */
  private async ensureShiftAssigned(shiftId: string, supervisorId: string): Promise<string> {
    const turnos = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
      `SELECT site_id FROM shifts WHERE id = $1`,
      [shiftId],
    );
    const turno = turnos[0];
    if (!turno) throw new NotFoundException('El turno no existe');
    await this.supervisor.ensureAssignedSite(turno.site_id, supervisorId);
    return turno.site_id;
  }

  private async registrarAuditoria(
    supervisorId: string,
    input: { serviceDate: string; siteId?: string },
    generated: number,
    skipped: number,
  ) {
    const actores = await this.tenantContext.manager.query<Array<{ label: string }>>(
      `SELECT (given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
      [supervisorId],
    );
    await this.audit.record({
      actorId: supervisorId,
      actorLabel: actores[0]?.label ?? 'SUPERVISOR',
      action: 'rondas.generadas',
      entityType: 'schedule_run',
      entityId: input.siteId,
      summary: `${input.serviceDate}: ${generated} generadas, ${skipped} omitidas`,
    });
  }
}
