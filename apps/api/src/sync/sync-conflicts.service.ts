import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import {
  avisoDeReloj,
  medirDesfase,
  minutosDeDesfase,
  toleranciaEnMs,
  type FuenteDelInstante,
  type MedicionDeReloj,
} from './device-clock';
import { sugerenciaPara } from './late-scan.policy';
import type {
  ClasificacionDeAtraso,
  EstadoDeRondaCerrada,
  VeredictoDeAtraso,
} from './late-scan.policy';
import type { ReviewDecision } from './dto/review-late-scan.dto';

/** Lo que hace falta guardar de un escaneo que llego con la ronda ya cerrada. */
export interface DatosDeAtraso {
  readonly patrolId: string;
  readonly guardId: string;
  readonly clientScanId: string;
  readonly tagUid: string;
  readonly method: 'nfc' | 'qr';
  readonly patrolStatus: EstadoDeRondaCerrada;
  readonly clasificacion: ClasificacionDeAtraso;
  readonly minutosDeAtraso: number;
  readonly graciaMin: number;
  readonly scannedAtDevice: string | null;
  readonly scannedAtEffective: Date;
  readonly fuenteDelInstante: FuenteDelInstante;
  readonly clockOffsetMs: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyM: number | null;
}

/**
 * Error que levanta la operacion de escaneo cuando la ronda ya estaba cerrada.
 *
 * Extiende ConflictException para que el resto del lote lo trate como cualquier
 * rechazo (motivo legible, sin 500) y ADEMAS lleve consigo los datos que hacen
 * falta para guardar el anexo. El anexo NO se escribe aca: se escribe despues de
 * soltar el savepoint de la operacion, o el rollback se lo llevaria.
 */
export class EscaneoAtrasadoError extends ConflictException {
  constructor(
    readonly veredicto: VeredictoDeAtraso,
    readonly datos: DatosDeAtraso,
  ) {
    super(veredicto.mensaje);
  }
}

interface RondaDeLaOperacion {
  readonly status: string;
  readonly closedAt: Date | null;
  readonly scheduledEndAt: Date;
  readonly siteId: string;
  /** now() de PostgreSQL: la unica hora que este sistema considera cierta. */
  readonly serverNow: Date;
}

interface FilaDeAtraso {
  id: string;
  patrol_id: string;
  guard_id: string;
  guard_name: string;
  route_name: string;
  timezone: string;
  checkpoint_name: string | null;
  tag_uid: string;
  method: string;
  patrol_status: EstadoDeRondaCerrada;
  classification: ClasificacionDeAtraso;
  minutes_late: number;
  grace_min: number;
  scanned_at_device: Date | null;
  scanned_at_effective: Date;
  effective_source: FuenteDelInstante;
  clock_offset_ms: string | null;
  received_at_server: Date;
  reviewed_at: Date | null;
  review_decision: ReviewDecision | null;
  review_note: string | null;
}

/**
 * Reloj del dispositivo y escaneos atrasados (#73).
 *
 * Vive aparte de SyncService por una razon concreta: SyncService orquesta el
 * lote y no deberia saber SQL de tres tablas mas. Aca esta todo lo que toca la
 * base para estas dos cosas, y las decisiones puras viven en device-clock.ts y
 * late-scan.policy.ts, que se prueban sin base.
 */
@Injectable()
export class SyncConflictsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    // El control de "este recinto es tuyo" NO se reimplementa: duplicar un
    // control de acceso es la clase de codigo que se arregla en un lado y se
    // olvida en el otro. Requiere que SupervisorModule exporte el servicio.
    private readonly supervisor: SupervisorService,
  ) {}

  // ------------------------------------------------------- reloj del equipo

  /**
   * Mide el reloj del telefono contra el del servidor y deja la medicion
   * escrita. Una sola vez por lote: el desfase es del equipo, no de cada
   * operacion.
   *
   * Sin hora de envio no hay medicion (app antigua): devuelve null y el lote
   * sigue su curso. Nunca se inventa un offset.
   */
  async medirReloj(
    guardId: string,
    deviceTime: string | undefined,
    toleranciaMin: number,
    operaciones: number,
  ): Promise<MedicionDeReloj | null> {
    if (!deviceTime) return null;

    const filas = await this.tenantContext.manager.query<
      Array<{ device_reported_at: Date; server_received_at: Date }>
    >(
      `INSERT INTO device_clock_readings (
         tenant_id, guard_id, device_reported_at, tolerance_ms, operations
       ) VALUES (app_tenant_id(), $1, $2::timestamptz, $3, $4)
       RETURNING device_reported_at, server_received_at`,
      [guardId, deviceTime, toleranciaEnMs(toleranciaMin), operaciones],
    );

    const fila = filas[0];
    if (!fila) return null;
    return medirDesfase(fila.device_reported_at, fila.server_received_at, toleranciaMin);
  }

  /**
   * Estado del reloj del guardia, para que la app lo compare ANTES de salir a
   * terreno. Sin efectos: consultar la hora no puede escribir una medicion, o
   * cada refresco de pantalla ensuciaria la bitacora.
   */
  async estadoDelReloj(guardId: string, toleranciaMin: number) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        server_now: Date;
        device_reported_at: Date | null;
        server_received_at: Date | null;
      }>
    >(
      `SELECT now() AS server_now,
              ultima.device_reported_at,
              ultima.server_received_at
       FROM (SELECT 1) AS presente
       LEFT JOIN (
         SELECT device_reported_at, server_received_at
         FROM device_clock_readings
         WHERE guard_id = $1
         ORDER BY server_received_at DESC
         LIMIT 1
       ) AS ultima ON true`,
      [guardId],
    );

    // Sin GROUP BY y con LEFT JOIN sobre una fila fija: siempre viene una fila.
    const fila = filas[0]!;
    const medicion = medirDesfase(
      fila.device_reported_at,
      fila.server_received_at,
      toleranciaMin,
    );

    return {
      serverTime: fila.server_now,
      toleranceMin: toleranciaMin,
      lastReading: medicion
        ? {
            deviceReportedAt: fila.device_reported_at,
            serverReceivedAt: fila.server_received_at,
            offsetMs: medicion.offsetMs,
            offsetMin: minutosDeDesfase(medicion),
            skewed: medicion.desfasado,
          }
        : null,
      warning: avisoDeReloj(medicion),
    };
  }

  /**
   * Deja escrito en el escaneo que el reloj del equipo estaba fuera de
   * tolerancia. Se MARCA, no se descarta: descartar castigaria al guardia por
   * la configuracion de su telefono.
   *
   * La hora cruda (scanned_at_device) no se toca nunca. Lo que se guarda es el
   * offset con que hay que corregirla al leer.
   */
  async marcarRelojDesfasado(patrolId: string, clientScanId: string, offsetMs: number) {
    await this.tenantContext.manager.query(
      `UPDATE scans
       SET clock_offset_ms = $3,
           anomalies = CASE
             WHEN anomalies @> '["reloj_desfasado"]'::jsonb THEN anomalies
             ELSE anomalies || '["reloj_desfasado"]'::jsonb
           END
       WHERE patrol_id = $1 AND client_scan_id = $2`,
      [patrolId, clientScanId, offsetMs],
    );
  }

  // --------------------------------------------------- escaneos atrasados

  /**
   * Estado de la ronda a la que apunta la operacion, con la hora del servidor.
   *
   * Devuelve null cuando la ronda no existe o no es de ese guardia: ahi no
   * decide nada este modulo, deja que registerScan conteste lo que corresponde
   * (404) y no duplica la semantica del error.
   */
  async rondaDeLaOperacion(
    patrolId: string,
    guardId: string,
  ): Promise<RondaDeLaOperacion | null> {
    const filas = await this.tenantContext.manager.query<
      Array<{
        status: string;
        closed_at: Date | null;
        scheduled_end_at: Date;
        site_id: string;
        server_now: Date;
      }>
    >(
      `SELECT status, closed_at, scheduled_end_at, site_id, now() AS server_now
       FROM patrols
       WHERE id = $1 AND guard_id = $2`,
      [patrolId, guardId],
    );

    const fila = filas[0];
    if (!fila) return null;
    return {
      status: fila.status,
      closedAt: fila.closed_at,
      scheduledEndAt: fila.scheduled_end_at,
      siteId: fila.site_id,
      serverNow: fila.server_now,
    };
  }

  /**
   * Guarda el escaneo atrasado. Idempotente por (ronda, clave del dispositivo):
   * reenviar la cola no deja dos anexos del mismo escaneo.
   *
   * Devuelve null cuando ya estaba guardado — es un reenvio, no un error.
   */
  async registrarAtrasado(datos: DatosDeAtraso): Promise<string | null> {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO late_scans (
         tenant_id, patrol_id, guard_id, client_scan_id, tag_uid, method,
         patrol_status, classification, minutes_late, grace_min,
         scanned_at_device, scanned_at_effective, effective_source, clock_offset_ms,
         latitude, longitude, accuracy_m
       ) VALUES (
         app_tenant_id(), $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16
       )
       ON CONFLICT (tenant_id, patrol_id, client_scan_id) DO NOTHING
       RETURNING id`,
      [
        datos.patrolId,
        datos.guardId,
        datos.clientScanId,
        datos.tagUid,
        datos.method,
        datos.patrolStatus,
        datos.clasificacion,
        datos.minutosDeAtraso,
        datos.graciaMin,
        datos.scannedAtDevice,
        datos.scannedAtEffective,
        datos.fuenteDelInstante,
        datos.clockOffsetMs,
        datos.latitude,
        datos.longitude,
        datos.accuracyM,
      ],
    );
    return filas[0]?.id ?? null;
  }

  /**
   * Bandeja del supervisor para un recinto SUYO. Lo pendiente de revisar va
   * primero: es lo unico sobre lo que todavia se puede hacer algo.
   *
   * Devuelve tambien la zona horaria del recinto para que el panel muestre las
   * horas donde pasaron las cosas y no donde esta el servidor.
   */
  async listarAtrasados(siteId: string, supervisorId: string) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);

    const filas = await this.tenantContext.manager.query<FilaDeAtraso[]>(
      `SELECT ls.id, ls.patrol_id, ls.guard_id,
              (u.given_name || ' ' || u.family_name) AS guard_name,
              r.name AS route_name,
              s.timezone,
              c.name AS checkpoint_name,
              ls.tag_uid, ls.method,
              ls.patrol_status, ls.classification, ls.minutes_late, ls.grace_min,
              ls.scanned_at_device, ls.scanned_at_effective, ls.effective_source,
              ls.clock_offset_ms, ls.received_at_server,
              ls.reviewed_at, ls.review_decision, ls.review_note
       FROM late_scans ls
       JOIN patrols p ON p.id = ls.patrol_id
       JOIN sites s ON s.id = p.site_id
       JOIN routes r ON r.id = p.route_id
       JOIN users u ON u.id = ls.guard_id
       LEFT JOIN tags t ON t.uid = ls.tag_uid AND t.is_active
       LEFT JOIN checkpoints c ON c.id = t.checkpoint_id
       WHERE p.site_id = $1
       ORDER BY (ls.reviewed_at IS NULL) DESC, ls.received_at_server DESC
       LIMIT 100`,
      [siteId],
    );

    return filas.map((fila) => ({
      id: fila.id,
      patrolId: fila.patrol_id,
      guardId: fila.guard_id,
      guardName: fila.guard_name,
      routeName: fila.route_name,
      // El panel formatea con esta zona, no con la del navegador ni la del servidor.
      timezone: fila.timezone,
      checkpointName: fila.checkpoint_name,
      tagUid: fila.tag_uid,
      method: fila.method,
      patrolStatus: fila.patrol_status,
      classification: fila.classification,
      minutesLate: fila.minutes_late,
      graceMin: fila.grace_min,
      scannedAtDevice: fila.scanned_at_device,
      scannedAtEffective: fila.scanned_at_effective,
      effectiveSource: fila.effective_source,
      // bigint llega como string desde el driver.
      clockOffsetMs: fila.clock_offset_ms === null ? null : Number(fila.clock_offset_ms),
      receivedAtServer: fila.received_at_server,
      reviewedAt: fila.reviewed_at,
      reviewDecision: fila.review_decision,
      reviewNote: fila.review_note,
      suggestion: sugerenciaPara(fila.classification),
      pending: fila.reviewed_at === null,
    }));
  }

  /**
   * El supervisor resuelve un escaneo atrasado. Queda quien lo reviso, cuando y
   * que decidio: una revision anonima no le sirve a nadie que despues tenga que
   * explicarla.
   *
   * Revisar NO reabre la ronda ni recalcula su cumplimiento (ver
   * late-scan.policy.ts): deja constancia de como se leyo ese escaneo.
   */
  async revisar(
    lateScanId: string,
    supervisorId: string,
    decision: ReviewDecision,
    nota: string | undefined,
  ) {
    const contexto = await this.tenantContext.manager.query<
      Array<{ site_id: string; reviewed_at: Date | null }>
    >(
      `SELECT p.site_id, ls.reviewed_at
       FROM late_scans ls
       JOIN patrols p ON p.id = ls.patrol_id
       WHERE ls.id = $1`,
      [lateScanId],
    );

    const fila = contexto[0];
    if (!fila) throw new NotFoundException('Esa marca atrasada no existe');
    await this.supervisor.ensureAssignedSite(fila.site_id, supervisorId);
    if (fila.reviewed_at) {
      throw new ConflictException('Esa marca atrasada ya fue revisada');
    }

    // UPDATE envuelto en CTE a proposito: con el driver de PostgreSQL un
    // UPDATE ... RETURNING devuelve [filas, cantidad], no las filas. Envuelto en
    // un SELECT, lo que llega son filas y nada mas.
    const revisadas = await this.tenantContext.manager.query<
      Array<{ id: string; reviewed_at: Date; review_decision: ReviewDecision }>
    >(
      `WITH revisado AS (
         UPDATE late_scans
         SET reviewed_by = $2, reviewed_at = now(), review_decision = $3, review_note = $4
         WHERE id = $1 AND reviewed_at IS NULL
         RETURNING id, reviewed_at, review_decision
       )
       SELECT id, reviewed_at, review_decision FROM revisado`,
      [lateScanId, supervisorId, decision, nota ?? null],
    );

    const revisada = revisadas[0];
    // Otro supervisor la reviso entre la lectura y la escritura.
    if (!revisada) throw new ConflictException('Esa marca atrasada ya fue revisada');

    return {
      id: revisada.id,
      reviewedAt: revisada.reviewed_at,
      reviewDecision: revisada.review_decision,
    };
  }
}
