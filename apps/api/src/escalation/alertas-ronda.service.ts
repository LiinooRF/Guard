import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PatrolRules } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { EventsStreamService, type StreamEvent } from '../events-stream/events-stream.service';
import { deepLinkDeEvento, deepLinkDeRonda } from '../push/deep-link';
import { PushService } from '../push/push.service';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import {
  ALERT_TITULOS,
  type AlertKind,
  type AlertSeverity,
} from './alertas-ronda.dto';

/* -------------------------------------------------------------------------- *
 * Parametros de negocio
 *
 * NINGUNO de estos numeros deberia vivir aca: los cuatro van a rules.ts con su
 * ficha, su rango y su default, y el integrador los agrega (estan escritos uno
 * por uno en INTEGRACION.md). Mientras tanto se leen del objeto de reglas y solo
 * se cae a este puente cuando la clave todavia no existe, para que el tablero
 * opere el dia que se despliegue este modulo aunque rules.ts vaya en otro PR.
 *
 * QUE HACER AL INTEGRAR: agregar las cuatro claves a patrolRulesSchema y a
 * PATROL_RULE_CATALOG, y borrar PUENTE_REGLAS junto con parametro().
 * -------------------------------------------------------------------------- */
const PUENTE_REGLAS = {
  /** Minutos de gracia para que una ronda 'pendiente' arranque. */
  patrolStartGraceMin: 10,
  /** Minutos de gracia tras el cierre de la ventana antes de marcarla atrasada. */
  patrolLateGraceMin: 15,
  /** Escaneos con marca de anomalia en la misma ronda que disparan la alerta. */
  alertAnomalyScanThreshold: 3,
  /** Dias hacia atras que revisa el detector. */
  alertLookbackDays: 3,
} as const;

type ClaveAlerta = keyof typeof PUENTE_REGLAS;

function parametro(rules: PatrolRules, clave: ClaveAlerta): number {
  const valor = (rules as unknown as Record<string, unknown>)[clave];
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : PUENTE_REGLAS[clave];
}

/* -------------------------------------------------------------------------- *
 * SQL
 *
 * TRAMPA DEL DRIVER (no la repitas): con PostgreSQL, `manager.query()` de un
 * UPDATE o un DELETE devuelve `[filas, rowCount]`, NO un arreglo plano de filas
 * (typeorm/driver/postgres/PostgresQueryRunner: `case "UPDATE": result.raw =
 * [raw.rows, raw.rowCount]`). Por eso TODA escritura que necesita leer sus
 * filas va envuelta en un CTE y se lee con un SELECT: asi el comando de la
 * sentencia es SELECT y el resultado vuelve plano. Es el mismo patron de
 * GuardService.startPatrol.
 * -------------------------------------------------------------------------- */

/**
 * Detecta las condiciones de ronda y deja la fila. Todo en una sentencia: cada
 * rama es un hecho distinto sobre la misma ronda y calcularlas por separado
 * obligaria a recorrer `patrols` cinco veces.
 *
 * `detected_at` es el instante en que la condicion SE CUMPLIO, no en que la
 * vimos: la ronda que no arranco lleva la hora del vencimiento de su tolerancia
 * aunque el detector pase quince minutos despues. Sin eso el tablero ordena por
 * la hora de la corrida y todas las alertas se ven igual de recientes.
 *
 * $1 recinto · $2 dias de ventana · $3 gracia de inicio · $4 gracia de atraso
 * $5 duracion maxima · $6 umbral de cumplimiento · $7 escaneos marcados minimos
 */
const SQL_DETECTAR_RONDAS = `
  WITH ronda AS (
    SELECT
      p.id,
      p.site_id,
      p.status,
      p.scheduled_start_at,
      p.scheduled_end_at,
      p.started_at,
      p.closed_at,
      p.compliance_pct,
      p.is_voluntary,
      app_stats_service_day(p.scheduled_start_at, a.service_date, s.timezone) AS service_day,
      (
        SELECT count(*)
        FROM scans sc
        WHERE sc.tenant_id = p.tenant_id
          AND sc.patrol_id = p.id
          AND jsonb_array_length(sc.anomalies) > 0
      ) AS escaneos_marcados
    FROM patrols p
    JOIN sites s
      ON s.tenant_id = p.tenant_id AND s.id = p.site_id
    LEFT JOIN shift_assignments a
      ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
    WHERE p.tenant_id = app_tenant_id()
      AND p.site_id = $1::uuid
      AND p.scheduled_start_at >= app_alertas_desde(s.timezone, $2::integer)
  ),
  candidata AS (
    -- No iniciada. Es la unica que NO espera al cierre: la ronda de las 22:00
    -- que nadie arranco hay que salvarla a las 22:10, no leerla mañana.
    --
    -- Las tres primeras ramas descartan las rondas VOLUNTARIAS (#133): son
    -- cobertura extra que el guardia decidio hacer, no lo programado. Alertar
    -- por una ronda que nadie pidio castiga justo al que hizo de mas.
    SELECT
      r.id AS patrol_id,
      r.site_id,
      r.service_day,
      'no_iniciada'::text AS kind,
      'alta'::text AS severity,
      r.scheduled_start_at + ($3::integer * INTERVAL '1 minute') AS detected_at,
      jsonb_build_object('toleranceMin', $3::integer) AS detail
    FROM ronda r
    WHERE r.status = 'pendiente'
      AND NOT r.is_voluntary
      AND now() >= r.scheduled_start_at + ($3::integer * INTERVAL '1 minute')

    UNION ALL

    -- Atrasada: arranco, la ventana ya cerro y sigue abierta.
    SELECT
      r.id,
      r.site_id,
      r.service_day,
      'atrasada'::text,
      'media'::text,
      r.scheduled_end_at + ($4::integer * INTERVAL '1 minute'),
      jsonb_build_object('toleranceMin', $4::integer)
    FROM ronda r
    WHERE r.status = 'en_curso'
      AND NOT r.is_voluntary
      AND now() >= r.scheduled_end_at + ($4::integer * INTERVAL '1 minute')

    UNION ALL

    -- Vencida: paso la duracion maxima sin cerrarse, o alguien ya la marco.
    -- No cubre la ronda que nunca arranco: esa es 'no_iniciada' y avisar dos
    -- veces del mismo hecho es como no avisar.
    SELECT
      r.id,
      r.site_id,
      r.service_day,
      'vencida'::text,
      'alta'::text,
      CASE
        WHEN r.status = 'vencida' THEN now()
        ELSE COALESCE(r.started_at, r.scheduled_start_at)
             + ($5::integer * INTERVAL '1 minute')
      END,
      jsonb_build_object('maxDurationMin', $5::integer)
    FROM ronda r
    WHERE r.status = 'vencida'
       OR (
         r.status = 'en_curso'
         AND now() >= COALESCE(r.started_at, r.scheduled_start_at)
                      + ($5::integer * INTERVAL '1 minute')
       )

    UNION ALL

    -- Incompleta: cerro bajo el umbral vigente del tenant.
    SELECT
      r.id,
      r.site_id,
      r.service_day,
      'incompleta'::text,
      'media'::text,
      COALESCE(r.closed_at, now()),
      jsonb_build_object('compliancePct', r.compliance_pct, 'thresholdPct', $6::integer)
    FROM ronda r
    WHERE r.status IN ('completada', 'incompleta', 'vencida')
      AND NOT r.is_voluntary
      AND r.compliance_pct IS NOT NULL
      AND r.compliance_pct < $6::integer

    UNION ALL

    -- Escaneos sospechosos. Las anomalias MARCAN, no rechazan (ver CLAUDE.md):
    -- esto le avisa al supervisor para que mire, no invalida la ronda.
    SELECT
      r.id,
      r.site_id,
      r.service_day,
      'escaneos_sospechosos'::text,
      'media'::text,
      now(),
      jsonb_build_object('markedScans', r.escaneos_marcados, 'minScans', $7::integer)
    FROM ronda r
    WHERE r.escaneos_marcados >= $7::integer
  )
  INSERT INTO patrol_alerts (
    tenant_id, site_id, patrol_id, kind, severity, detected_at, service_day, detail
  )
  SELECT
    app_tenant_id(),
    c.site_id,
    c.patrol_id,
    c.kind,
    c.severity,
    c.detected_at,
    c.service_day,
    c.detail
  FROM candidata c
  ON CONFLICT (tenant_id, patrol_id, kind) WHERE patrol_id IS NOT NULL DO NOTHING
  RETURNING id, site_id, kind, severity, patrol_id, field_event_id
`;

/**
 * Incidente grave: las criticidades que el tenant declaro escalables (#126) se
 * asoman tambien en el tablero de alertas, para que el supervisor tenga UNA
 * bandeja y no dos.
 *
 * La entrada cancelada como falsa alarma (#127) no entra: se corrige con una
 * entrada 'info' que apunta a la original, y un panico ya desmentido no es un
 * incidente vivo. Tampoco entran las correcciones mismas.
 *
 * $1 recinto · $2 criticidades · $3 dias de ventana
 */
const SQL_DETECTAR_EVENTOS = `
  WITH evento AS (
    SELECT
      e.id,
      e.site_id,
      e.criticality,
      e.patrol_id,
      e.reported_at_server,
      app_stats_service_day(e.reported_at_server, NULL::date, s.timezone) AS service_day
    FROM field_events e
    JOIN sites s
      ON s.tenant_id = e.tenant_id AND s.id = e.site_id
    WHERE e.tenant_id = app_tenant_id()
      AND e.site_id = $1::uuid
      AND e.criticality = ANY($2::text[])
      AND e.reported_at_server >= app_alertas_desde(s.timezone, $3::integer)
      AND e.corrects_event_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM field_events correccion
        WHERE correccion.tenant_id = e.tenant_id
          AND correccion.corrects_event_id = e.id
          AND correccion.criticality = 'info'
      )
  )
  INSERT INTO patrol_alerts (
    tenant_id, site_id, patrol_id, field_event_id, kind, severity,
    detected_at, service_day, detail
  )
  SELECT
    app_tenant_id(),
    ev.site_id,
    NULL::uuid,
    ev.id,
    'incidente_grave'::text,
    'alta'::text,
    ev.reported_at_server,
    ev.service_day,
    jsonb_build_object('criticality', ev.criticality, 'patrolId', ev.patrol_id)
  FROM evento ev
  ON CONFLICT (tenant_id, field_event_id) WHERE field_event_id IS NOT NULL DO NOTHING
  RETURNING id, site_id, kind, severity, patrol_id, field_event_id
`;

/**
 * Toma las alertas de este recinto que todavia no se avisaron. El UPDATE va
 * envuelto en CTE (ver la trampa del driver arriba) y ademas es lo que hace que
 * dos lecturas simultaneas del tablero no manden el push dos veces: la primera
 * se lleva las filas, la segunda no encuentra ninguna con notified_at NULL.
 */
const SQL_TOMAR_SIN_AVISAR = `
  WITH tomadas AS (
    UPDATE patrol_alerts
    SET notified_at = now()
    WHERE tenant_id = app_tenant_id()
      AND site_id = $1::uuid
      AND notified_at IS NULL
      AND attended_at IS NULL
    RETURNING id, site_id, kind, severity, patrol_id, field_event_id, detected_at
  )
  SELECT t.id, t.site_id, t.kind, t.severity, t.patrol_id, t.field_event_id, t.detected_at
  FROM tomadas t
  ORDER BY t.detected_at
`;

/**
 * El tablero. `$2` en true deja solo lo pendiente, que es como arranca: es una
 * bandeja de trabajo y no un historico.
 *
 * El nombre del guardia se muestra porque el tablero del supervisor ya lo
 * muestra en el listado de rondas; lo que no puede salir es en el LOG.
 */
const SQL_LISTAR = `
  SELECT
    a.id,
    a.kind,
    a.severity,
    a.detected_at,
    a.service_day,
    a.detail,
    a.patrol_id,
    a.field_event_id,
    a.attended_at,
    a.attended_by,
    a.attended_comment,
    (quien.given_name || ' ' || quien.family_name) AS attended_by_name,
    p.status AS patrol_status,
    p.scheduled_start_at,
    p.scheduled_end_at,
    r.name AS route_name,
    (guardia.given_name || ' ' || guardia.family_name) AS guard_name
  FROM patrol_alerts a
  LEFT JOIN users quien ON quien.id = a.attended_by
  LEFT JOIN patrols p ON p.tenant_id = a.tenant_id AND p.id = a.patrol_id
  LEFT JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
  LEFT JOIN users guardia ON guardia.id = p.guard_id
  WHERE a.tenant_id = app_tenant_id()
    AND a.site_id = $1::uuid
    AND ($2::boolean IS NOT TRUE OR a.attended_at IS NULL)
  ORDER BY (a.attended_at IS NULL) DESC, a.detected_at DESC
  LIMIT 200
`;

/** El numerito del tablero: cuantas quedan sin atender, por tipo. */
const SQL_CONTAR_PENDIENTES = `
  SELECT a.kind, count(*)::text AS total
  FROM patrol_alerts a
  WHERE a.tenant_id = app_tenant_id()
    AND a.site_id = $1::uuid
    AND a.attended_at IS NULL
  GROUP BY a.kind
`;

/** Acuse. Envuelto en CTE por la trampa del driver. */
const SQL_ATENDER = `
  WITH atendida AS (
    UPDATE patrol_alerts
    SET attended_at = now(),
        attended_by = $2::uuid,
        attended_comment = $3
    WHERE tenant_id = app_tenant_id()
      AND id = $1::uuid
      AND attended_at IS NULL
    RETURNING id, site_id, kind, attended_at
  )
  SELECT acuse.id, acuse.site_id, acuse.kind, acuse.attended_at
  FROM atendida acuse
`;

/**
 * Destinatarios del push: los SUPERVISORES ASIGNADOS a ese recinto, no todos
 * los del tenant. Chequear el rol no alcanza (ver CLAUDE.md): mandarle la
 * alerta de un recinto que no supervisa le filtra datos que no le tocan y le
 * enseña a ignorar la proxima notificacion.
 */
const SQL_DESTINATARIOS = `
  SELECT DISTINCT m.user_id
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  JOIN supervisor_sites ss
    ON ss.tenant_id = m.tenant_id
   AND ss.supervisor_id = m.user_id
   AND ss.site_id = $1::uuid
  WHERE m.tenant_id = app_tenant_id()
    AND m.role_key = 'SUPERVISOR'
    AND u.is_active
`;

interface AlertaNueva {
  id: string;
  site_id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  patrol_id: string | null;
  field_event_id: string | null;
  detected_at?: Date;
}

interface FilaTablero {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  detected_at: Date;
  service_day: string;
  detail: Record<string, unknown> | null;
  patrol_id: string | null;
  field_event_id: string | null;
  attended_at: Date | null;
  attended_by: string | null;
  attended_comment: string | null;
  attended_by_name: string | null;
  patrol_status: string | null;
  scheduled_start_at: Date | null;
  scheduled_end_at: Date | null;
  route_name: string | null;
  guard_name: string | null;
}

/**
 * Aviso en el tablero en vivo (#128). El emisor de la bandeja todavia no conoce
 * este `type`: la variante hay que agregarla a `StreamEvent` en
 * events-stream.service.ts (el bloque exacto esta en INTEGRACION.md, y ese
 * archivo esta fuera de este carril). Mientras no este, el aviso viaja igual —
 * el emisor no inspecciona el contenido— pero el tipo no lo cubre, y por eso el
 * publish lleva una conversion explicita en vez de quedar sin tipar.
 */
export interface AlertaRondaStreamEvent {
  type: 'alerta_ronda';
  siteId: string;
  alertId: string;
  kind: AlertKind;
  severity: AlertSeverity;
  patrolId: string | null;
  eventId: string | null;
  detectedAt: string;
}

@Injectable()
export class AlertasRondaService {
  private readonly logger = new Logger(AlertasRondaService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly supervisor: SupervisorService,
    private readonly push: PushService,
    private readonly bandeja: EventsStreamService,
  ) {}

  // ---------------------------------------------------------------- tablero

  /**
   * El tablero del supervisor. Evalua ANTES de leer, con el mismo criterio que
   * StatsChartsService rellena sus cubos en la primera lectura: asi la alerta
   * de la ronda que no arranco aparece sin esperar a que exista el worker.
   *
   * Que un GET escriba no es un descuido: la deteccion es idempotente (indices
   * unicos parciales sobre patrol_alerts) y corre dentro de la transaccion del
   * request. Cuando exista el worker repetible este llamado se puede sacar y el
   * endpoint queda de solo lectura sin cambiar nada mas.
   */
  async listar(siteId: string, supervisorId: string, soloPendientes: boolean) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    const evaluacion = await this.evaluarRecinto(siteId);

    const filas = await this.tenantContext.manager.query<FilaTablero[]>(SQL_LISTAR, [
      siteId,
      soloPendientes,
    ]);
    const conteos = await this.tenantContext.manager.query<
      Array<{ kind: AlertKind; total: string }>
    >(SQL_CONTAR_PENDIENTES, [siteId]);

    // count(*) viaja como texto para no perder precision en el driver; el tipo
    // de la tupla se fija con `as const` o Object.fromEntries no compila.
    const pendientesPorTipo = Object.fromEntries(
      conteos.map((c) => [c.kind, Number(c.total)] as const),
    ) as Partial<Record<AlertKind, number>>;

    return {
      siteId,
      onlyPending: soloPendientes,
      detectedNow: evaluacion.detected,
      pendingTotal: Object.values(pendientesPorTipo).reduce((total, n) => total + (n ?? 0), 0),
      pendingByKind: pendientesPorTipo,
      alerts: filas.map((f) => ({
        id: f.id,
        kind: f.kind,
        title: ALERT_TITULOS[f.kind],
        severity: f.severity,
        detectedAt: f.detected_at,
        serviceDay: f.service_day,
        detail: f.detail ?? {},
        patrolId: f.patrol_id,
        eventId: f.field_event_id,
        patrolStatus: f.patrol_status,
        scheduledStartAt: f.scheduled_start_at,
        scheduledEndAt: f.scheduled_end_at,
        routeName: f.route_name,
        guardName: f.guard_name,
        attendedAt: f.attended_at,
        attendedById: f.attended_by,
        attendedByName: f.attended_by_name,
        attendedComment: f.attended_comment,
      })),
    };
  }

  /**
   * Alguien se hizo cargo. Un segundo acuse es 409: manda el primero, igual que
   * en el acuse de escalamiento.
   *
   * El recinto se verifica ANTES de escribir: sin eso, un supervisor podria
   * cerrar la alerta de un recinto que no supervisa con solo adivinar el id.
   */
  async atender(alertId: string, supervisorId: string, comment: string) {
    const previas = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
      `SELECT site_id FROM patrol_alerts
       WHERE tenant_id = app_tenant_id() AND id = $1::uuid`,
      [alertId],
    );
    const previa = previas[0];
    if (!previa) throw new NotFoundException('La alerta no existe');
    await this.supervisor.ensureAssignedSite(previa.site_id, supervisorId);

    const filas = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string; kind: AlertKind; attended_at: Date }>
    >(SQL_ATENDER, [alertId, supervisorId, comment.trim()]);

    const atendida = filas[0];
    if (!atendida) {
      throw new ConflictException('Esa alerta ya está marcada como atendida');
    }

    return {
      id: atendida.id,
      kind: atendida.kind,
      attendedAt: atendida.attended_at,
      attendedById: supervisorId,
      attendedComment: comment.trim(),
    };
  }

  // --------------------------------------------------------------- deteccion

  /**
   * Evalua un recinto y avisa lo nuevo. Publico a proposito: es la CONSULTA del
   * job, no el job.
   *
   * EL CRON NO ESTA IMPLEMENTADO A PROPOSITO, por la misma razon que en
   * EscalationService.pendingEscalations: un scheduler dentro de la API se
   * dispara en cada replica y manda la alerta N veces. Cuando exista va como
   * worker BullMQ repetible que recorre los recintos activos y llama a este
   * metodo dentro de la transaccion de cada tenant (ver INTEGRACION.md).
   *
   * No lanza: una falla del detector no puede botar la lectura del tablero, que
   * es lo que el supervisor necesita para trabajar.
   */
  async evaluarRecinto(siteId: string): Promise<{ detected: number; notified: number }> {
    let nuevas: AlertaNueva[] = [];
    try {
      const reglas = await this.rules.effective({ siteId });
      const deRondas = await this.tenantContext.manager.query<AlertaNueva[]>(
        SQL_DETECTAR_RONDAS,
        [
          siteId,
          parametro(reglas, 'alertLookbackDays'),
          parametro(reglas, 'patrolStartGraceMin'),
          parametro(reglas, 'patrolLateGraceMin'),
          reglas.maxPatrolDurationMin,
          reglas.complianceThreshold,
          parametro(reglas, 'alertAnomalyScanThreshold'),
        ],
      );
      const deEventos = await this.tenantContext.manager.query<AlertaNueva[]>(
        SQL_DETECTAR_EVENTOS,
        [
          siteId,
          [...reglas.escalationCriticalities],
          parametro(reglas, 'alertLookbackDays'),
        ],
      );
      nuevas = [...deRondas, ...deEventos];
    } catch (error) {
      // ERROR y no WARN: si esto falla, el supervisor ve un tablero vacio y cree
      // que la noche esta tranquila. Un detector roto en silencio es peor que no
      // tener detector, y tiene que salir en la consola de operacion.
      this.logger.error(
        JSON.stringify({
          event: 'alertas_deteccion_fallo',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return { detected: 0, notified: 0 };
    }

    const notified = await this.avisar(siteId);
    if (nuevas.length || notified) {
      // Sin identificadores de personas ni de recintos en el log (ver CLAUDE.md).
      this.logger.log(
        JSON.stringify({ event: 'alertas_detectadas', detected: nuevas.length, notified }),
      );
    }
    return { detected: nuevas.length, notified };
  }

  // ------------------------------------------------------------------ aviso

  /**
   * Push a la app del supervisor + aviso en el tablero en vivo, una sola vez
   * por alerta. Nunca lanza: la fila ya quedo escrita y vale mas que el aviso.
   *
   * El orden importa: PRIMERO se marca notified_at (dentro del CTE) y despues
   * se encola. Al reves, dos lecturas simultaneas mandarian el push dos veces.
   * El costo es que un fallo de Redis deja la alerta marcada como avisada sin
   * haberse avisado — y por eso PushService.send() no propaga errores y la
   * alerta sigue visible en el tablero, que es el canal que no depende de nadie.
   */
  private async avisar(siteId: string): Promise<number> {
    try {
      const tomadas = await this.tenantContext.manager.query<AlertaNueva[]>(
        SQL_TOMAR_SIN_AVISAR,
        [siteId],
      );
      if (!tomadas.length) return 0;

      const destinos = await this.tenantContext.manager.query<Array<{ user_id: string }>>(
        SQL_DESTINATARIOS,
        [siteId],
      );
      const recintos = await this.tenantContext.manager.query<
        Array<{ tenant_id: string; name: string }>
      >(
        `SELECT tenant_id, name FROM sites
         WHERE tenant_id = app_tenant_id() AND id = $1::uuid`,
        [siteId],
      );
      const recinto = recintos[0];
      if (!recinto) return 0;

      const supervisores = destinos.map((d) => d.user_id);
      for (const alerta of tomadas) {
        this.publicarEnTablero(recinto.tenant_id, alerta);
        if (!supervisores.length) continue;

        const referencia = alerta.patrol_id ?? alerta.field_event_id;
        await this.push.send(
          supervisores,
          {
            title: ALERT_TITULOS[alerta.kind],
            // Recinto y tipo alcanzan para decidir si hay que moverse. El resto
            // vive detras de la sesion: esto se lee en una pantalla bloqueada.
            body: `${recinto.name}: revisa el tablero de alertas.`,
            deepLink:
              alerta.patrol_id !== null
                ? deepLinkDeRonda(alerta.patrol_id, siteId)
                : alerta.field_event_id !== null
                  ? deepLinkDeEvento(alerta.field_event_id, siteId)
                  : { destino: 'inicio' as const },
            urgency: alerta.severity === 'alta' ? 'alta' : 'normal',
            // Dos alertas de la misma ronda se reemplazan en la bandeja del
            // telefono en vez de apilarse.
            collapseKey: `alerta:${referencia ?? alerta.id}`,
          },
          { idempotencyKey: `patrol-alert:${alerta.id}` },
        );
      }
      return tomadas.length;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'alertas_aviso_fallo',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    }
  }

  private publicarEnTablero(tenantId: string, alerta: AlertaNueva): void {
    const evento: AlertaRondaStreamEvent = {
      type: 'alerta_ronda',
      siteId: alerta.site_id,
      alertId: alerta.id,
      kind: alerta.kind,
      severity: alerta.severity,
      patrolId: alerta.patrol_id,
      eventId: alerta.field_event_id,
      detectedAt: (alerta.detected_at ?? new Date()).toISOString(),
    };
    // La conversion desaparece cuando 'alerta_ronda' entre en StreamEvent.
    this.bandeja.publish(tenantId, evento as unknown as StreamEvent);
  }
}
