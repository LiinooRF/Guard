import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { computeCompliance, type ScanAnomaly } from '@voxia/shared';
import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { EscalationService } from '../escalation/escalation.service';
import { GpsPolicyService } from '../geo/gps-policy.service';
import { MailQueueService } from '../mail/mail-queue.service';
import { EnvioInformeService } from '../reports/envio-informe.service';
import { RulesService } from '../rules/rules.service';
import type { CreateScanDto } from './dto/create-scan.dto';
import type { ReportEventDto } from './dto/report-event.dto';
import type { ShiftMarkDto } from './dto/shift-mark.dto';
import { DeviceSignatureService } from './device-signature.service';

interface PatrolRow {
  id: string;
  status: 'pendiente' | 'en_curso' | 'completada' | 'incompleta' | 'vencida';
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  site_id: string;
  site_name: string;
  site_timezone: string;
  route_name: string;
  estimated_duration_min: number;
  checkpoints: Array<{
    id: string;
    name: string;
    position: number;
    isClosingPoint: boolean;
    // Coordenadas del punto para dibujarlo en el visor de ruta (#76). Pueden ser
    // null: un punto puede no estar geolocalizado y el mapa lo omite.
    latitude: number | null;
    longitude: number | null;
    tagUids: string[];
  }>;
}

@Injectable()
export class GuardService {
  private readonly logger = new Logger(GuardService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly mail: MailQueueService,
    private readonly rules: RulesService,
    private readonly escalation: EscalationService,
    private readonly gpsPolicy: GpsPolicyService,
    private readonly envioInforme: EnvioInformeService,
    // Va al final y opcional: varios specs construyen el servicio por posicion.
    private readonly signatures?: DeviceSignatureService,
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
          p.site_id,
          s.name AS site_name,
          s.timezone AS site_timezone,
          r.name AS route_name,
          r.estimated_duration_min,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', c.id,
                'name', c.name,
                'position', rc.position,
                'isClosingPoint', rc.is_closing_point,
                'latitude', c.latitude,
                'longitude', c.longitude,
                'tagUids', COALESCE((
                  SELECT jsonb_agg(t.uid ORDER BY t.installed_at DESC)
                  FROM tags t
                  WHERE t.tenant_id = p.tenant_id
                    AND t.checkpoint_id = c.id
                    AND t.is_active
                ), '[]'::jsonb)
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
        GROUP BY p.id, p.site_id, s.name, r.name, r.estimated_duration_min
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

    const reglas = await this.rules.effective({ siteId: patrol.site_id });

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
        // La zona del RECINTO, no la del telefono ni la del servidor. El portal
        // la necesita para la marca de agua de la foto, que se QUEMA en los
        // pixeles: una hora mal impresa en la evidencia no se puede corregir
        // despues como se corrige una pantalla.
        timezone: patrol.site_timezone,
        routeName: patrol.route_name,
        estimatedDurationMin: patrol.estimated_duration_min,
        startedAt: patrol.started_at,
        completedCheckpointCount: 0,
        checkpoints: patrol.checkpoints,
      },
      /*
       * El presupuesto de la foto, resuelto en la cascada DEL RECINTO y no
       * decidido por el telefono.
       *
       * Son dos numeros distintos a proposito: `targetBytes` es a lo que el
       * telefono comprime antes de subir, y `maxBytes` es el techo que el
       * servidor acepta. El objetivo se acota al techo — un admin que baje el
       * maximo por debajo del objetivo no puede dejar al portal generando fotos
       * que su propio servidor va a rechazar.
       */
      photoBudget: {
        targetBytes: Math.min(
          reglas.photoUploadTargetKB * 1024,
          reglas.photoMaxSizeMB * 1024 * 1024,
        ),
        maxBytes: reglas.photoMaxSizeMB * 1024 * 1024,
      },
      connection: { status: 'online' as const },
      synchronization: { pendingItems: 0 },
    };
  }

  async startPatrol(patrolId: string, guardId: string) {
    // La puerta de GPS (#77) va ANTES de poner la ronda en curso: si el tenant
    // exige ubicacion y el telefono no la da, la ronda no arranca. Ademas deja
    // escrita la decision, y esa parte es la que importa despues — sin ella una
    // ronda sin recorrido no distingue "el guardia uso una opcion que la empresa
    // le dio" de "se cayo el GPS".
    await this.gpsPolicy.assertPatrolStartAllowed(guardId, patrolId);

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
    // En producción siempre está inyectado. Es opcional solo para que los tests
    // unitarios de reglas no construyan criptografía ni ConfigModule.
    const estadoFirma = await this.signatures?.verify(guardId, input);
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
    if (estadoFirma === 'legacy') anomalies.push('firma_dispositivo_ausente');
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
        tenant_id, patrol_id, guard_id, checkpoint_id, tag_id, method, client_scan_id,
        scanned_at_device, latitude, longitude, accuracy_m, anomalies,
        device_id, device_signature
      ) VALUES (
        app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13
      )
      ON CONFLICT (tenant_id, patrol_id, client_scan_id) DO NOTHING
      RETURNING id`,
      [
        patrolId,
        guardId,
        target.checkpoint_id,
        target.tag_id,
        input.method,
        input.clientScanId,
        input.scannedAt ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.accuracyM ?? null,
        JSON.stringify(anomalies),
        input.deviceId ?? null,
        input.signature ?? null,
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

      /*
       * Aca se dispara el informe automatico (#86). Estaba TODO construido y
       * nadie lo llamaba: el criterio "cerrar la ronda deja el PDF en el correo
       * sin accion manual" se cumplia solo por el barrido de rezagadas, o sea
       * entre 15 y 25 minutos tarde.
       *
       * alCerrarRonda() solo ENCOLA: el escaneo responde enseguida y el guardia
       * no espera parado frente a la puerta a que se dibuje un PDF.
       *
       * Reemplaza a alertarBajoUmbral(), que mandaba un aviso en texto plano,
       * sin PDF y sin quedar en la bitacora de envios. El carril nuevo manda las
       * dos cosas —informe a los destinatarios y alerta con OTRO asunto a los
       * administradores— con el mismo PDF adjunto. Dejar los dos daba DOS
       * correos por la misma ronda mala.
       */
      try {
        await this.envioInforme.alCerrarRonda(patrolId);
      } catch (error) {
        // Fallar al encolar no puede tumbar el escaneo: la ronda ya esta cerrada
        // con su cumplimiento persistido, y el barrido de rezagadas la recoge.
        this.logger.warn(
          JSON.stringify({
            event: 'envio_informe_no_encolado',
            patrol_id: patrolId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
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

  // ------------------------------------------------- jornada (#131) y #133

  /**
   * Marcaje de ENTRADA. Operativo, no registro legal de asistencia.
   * El traspaso de turno admite solape: el entrante marca entrada aunque el
   * saliente todavia no haya marcado salida.
   */
  async startShift(guardId: string, input: ShiftMarkDto) {
    const filas = await this.tenantContext.manager.query<
      Array<{ id: string; status: string; shift_name: string }>
    >(
      `SELECT a.id, a.status, s.name AS shift_name
       FROM shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
       WHERE a.guard_id = $1
         AND a.service_date BETWEEN current_date - 1 AND current_date + 1
         AND a.status = 'asignado'
       ORDER BY a.service_date DESC
       LIMIT 1`,
      [guardId],
    );
    const asignacion = filas[0];
    if (!asignacion) {
      throw new NotFoundException('No tienes un turno asignado para marcar entrada');
    }
    await this.tenantContext.manager.query(
      `UPDATE shift_assignments
       SET status = 'en_curso', started_at = now(),
           start_latitude = $2, start_longitude = $3
       WHERE id = $1`,
      [asignacion.id, input.latitude ?? null, input.longitude ?? null],
    );
    return {
      assignmentId: asignacion.id,
      shiftName: asignacion.shift_name,
      status: 'en_curso',
      onDuty: true,
    };
  }

  /** Marcaje de SALIDA de la jornada abierta. */
  async endShift(guardId: string, input: ShiftMarkDto) {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE shift_assignments
       SET status = 'cerrado', ended_at = now(),
           end_latitude = $2, end_longitude = $3
       WHERE id = (
         SELECT a.id FROM shift_assignments a
         WHERE a.guard_id = $1 AND a.status = 'en_curso'
         ORDER BY a.started_at DESC LIMIT 1
       )
       RETURNING id`,
      [guardId, input.latitude ?? null, input.longitude ?? null],
    );
    const cerrada = filas[0];
    if (!cerrada) throw new ConflictException('No tienes una jornada abierta');
    return { assignmentId: cerrada.id, status: 'cerrado', onDuty: false };
  }

  /**
   * Ronda VOLUNTARIA (#133): fuera de programacion. Se registra igual y queda
   * marcada; no cuenta contra el cumplimiento programado, suma como cobertura.
   */
  async startVoluntaryPatrol(guardId: string, routeId: string) {
    const rutas = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string }>
    >(`SELECT id, site_id FROM routes WHERE id = $1 AND is_active`, [routeId]);
    const ruta = rutas[0];
    if (!ruta) throw new NotFoundException('La ruta no existe o esta inactiva');

    const puntos = await this.tenantContext.manager.query<Array<{ checkpoint_id: string }>>(
      `SELECT checkpoint_id FROM route_checkpoints WHERE route_id = $1 ORDER BY position`,
      [routeId],
    );
    if (puntos.length < 2) throw new ConflictException('La ruta no tiene una secuencia valida');

    const jornada = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM shift_assignments
       WHERE guard_id = $1 AND status = 'en_curso'
       ORDER BY started_at DESC LIMIT 1`,
      [guardId],
    );

    const patrolId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO patrols (
        id, tenant_id, site_id, route_id, guard_id, status, started_at,
        scheduled_start_at, scheduled_end_at, expected_checkpoint_ids,
        shift_assignment_id, is_voluntary
      ) VALUES ($1, app_tenant_id(), $2, $3, $4, 'en_curso', now(),
                now(), now() + interval '12 hours', $5::jsonb, $6, true)`,
      [
        patrolId,
        ruta.site_id,
        routeId,
        guardId,
        JSON.stringify(puntos.map((p) => p.checkpoint_id)),
        jornada[0]?.id ?? null,
      ],
    );
    return {
      id: patrolId,
      status: 'en_curso',
      isVoluntary: true,
      expectedCheckpoints: puntos.length,
    };
  }

  /**
   * El acuse de un evento del propio guardia (#125).
   *
   * Apretar el boton de panico y no saber si llego deja al guardia igual de
   * solo que sin boton. El acuse vive en event_notifications, que es donde el
   * escalamiento anota quien recibio cada nivel.
   *
   * Se devuelve la ETIQUETA de quien acuso, nunca acknowledged_by: un UUID no
   * le sirve al guardia y expone el identificador de otra persona.
   */
  async eventAcknowledgement(eventId: string, guardId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{ acknowledged_at: Date | null; quien: string | null }>
    >(
      `SELECT n.acknowledged_at,
              (u.given_name || ' ' || u.family_name) AS quien
       FROM field_events e
       LEFT JOIN event_notifications n
         ON n.tenant_id = e.tenant_id AND n.field_event_id = e.id
        AND n.acknowledged_at IS NOT NULL
       LEFT JOIN users u ON u.id = n.acknowledged_by
       WHERE e.id = $1 AND e.guard_id = $2
       ORDER BY n.acknowledged_at
       LIMIT 1`,
      [eventId, guardId],
    );
    const fila = filas[0];
    // Un evento ajeno y uno inexistente dan lo mismo desde aca, y esa es la
    // respuesta correcta: no se confirma la existencia de eventos de otros.
    if (!fila) throw new NotFoundException('El evento no existe o no lo reportaste tu');

    return {
      eventId,
      acknowledgedAt: fila.acknowledged_at,
      acknowledgedByLabel: fila.acknowledged_at ? fila.quien : null,
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

    // Que criticidades escalan lo decide la regla del tenant (#126). El
    // reenvio idempotente sigue sin re-avisar.
    let notified = false;
    if (!replay) {
      notified = await this.notificarEvento(eventId!, patrol.site_id, guardId, input);
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
  private async notificarEvento(
    eventId: string,
    siteId: string,
    guardId: string,
    input: ReportEventDto,
  ) {
    try {
      const notificados = await this.escalation.notify(eventId, input.criticality, {
        siteId,
        guardId,
        text: input.text,
        latitude: input.latitude,
        longitude: input.longitude,
      });
      return notificados > 0;
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
