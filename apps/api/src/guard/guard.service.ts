import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { computeCompliance, type CheckpointKind, type PatrolRules, type ScanAnomaly } from '@sentrycore/shared';
import { randomUUID } from 'node:crypto';

import { normalizarUidNfc } from '../admin/uid-nfc';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { EscalationService } from '../escalation/escalation.service';
import { EvidenceService } from '../evidence/evidence.service';
import { GpsPolicyService } from '../geo/gps-policy.service';
import { MailQueueService } from '../mail/mail-queue.service';
import { EnvioInformeService } from '../reports/envio-informe.service';
import { RulesService } from '../rules/rules.service';
import type { CreateScanDto } from './dto/create-scan.dto';
import type { ReportEventDto } from './dto/report-event.dto';
import type { ShiftMarkDto } from './dto/shift-mark.dto';
import { DeviceSignatureService } from './device-signature.service';
import { dispositivoDuplicado, velocidadImposible } from './anomalias-de-secuencia';
import { rondaVencida } from './patrol-expiry';
import { filasDe } from '../consent/sql-result';
import {
  esRondaCerrada,
  evaluarEscaneoAtrasado,
  type EstadoDeRondaCerrada,
} from '../sync/late-scan.policy';

interface PatrolRow {
  id: string;
  status: 'pendiente' | 'en_curso' | 'completada' | 'incompleta' | 'vencida';
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  site_id: string;
  /** Puntos esperados con al menos un escaneo aceptado. Lo calcula el SQL. */
  completed_checkpoint_count: number;
  site_name: string;
  site_timezone: string;
  route_name: string;
  estimated_duration_min: number;
  checkpoints: Array<{
    id: string;
    name: string;
    position: number;
    isClosingPoint: boolean;
    // Criticidad del punto y override tri-estado de la foto. Sin estos dos
    // campos el telefono NO puede saber que el punto exige fotografiar la
    // puerta, que es el requisito del producto en los accesos criticos: la
    // pantalla los pasa tal cual a isPhotoRequired() de @sentrycore/shared.
    kind: CheckpointKind;
    /** null = hereda la regla; true/false la pisan en cualquier direccion. */
    requiresPhoto: boolean | null;
    // Coordenadas del punto para dibujarlo en el visor de ruta (#76). Pueden ser
    // null: un punto puede no estar geolocalizado y el mapa lo omite.
    latitude: number | null;
    longitude: number | null;
    tagUids: string[];
    /** Primer escaneo aceptado del punto en esta ronda; null = pendiente. */
    scannedAt: string | null;
  }>;
}

/**
 * Los INGREDIENTES con que el telefono decide si un punto exige foto, no el
 * veredicto ya masticado punto por punto.
 *
 * Se mandan los ingredientes porque la ronda ocurre sin señal: el telefono
 * tiene que poder decidir cuando ya no puede preguntar, y lo hace llamando a
 * isPhotoRequired() de @sentrycore/shared — la misma funcion que usa el servidor.
 * Mandar un booleano por punto obligaria a recalcularlo en el telefono cada vez
 * que cambia algo, que es exactamente la regla reimplementada que hay que
 * evitar.
 */
interface PoliticaDeFoto {
  /** Evaluado en la zona horaria DEL RECINTO, no la del servidor ni la del telefono. */
  withinBusinessHours: boolean;
  /** Cuando se evaluo. Una ronda larga puede cruzar el cierre del recinto. */
  evaluatedAt: string;
  rules: Pick<PatrolRules, 'photoRequiredOutsideHours' | 'photoRequiredOnCritical'>;
}

/**
 * La consulta de `GET /guard/home`, exportada COMO TEXTO a proposito: el spec
 * de integracion la PREPARA contra PostgreSQL real, que valida sintaxis y
 * tipos sin ejecutarla. Un `= ANY(jsonb)` paso por TypeScript y por todos los
 * mocks y tumbo el endpoint entero en staging; PREPARE lo habria cazado en CI.
 */
export const CONSULTA_HOME = `
        SELECT
          p.id,
          p.status,
          p.scheduled_start_at,
          p.scheduled_end_at,
          p.started_at,
          p.site_id,
          -- Cuantos puntos ESPERADOS tienen al menos un escaneo aceptado. Es el
          -- dato que estuvo anos como un cero escrito a mano (con un test que
          -- fijaba el cero): sin el, el portal no podia saber el avance real y
          -- decidio que "lo que quedo en el telefono manda" — con lo cual un
          -- escaneo perdido dejaba el punto marcado como hecho para siempre.
          (
            SELECT COUNT(DISTINCT sc.checkpoint_id)::int
            FROM scans sc
            WHERE sc.tenant_id = p.tenant_id
              AND sc.patrol_id = p.id
              -- expected_checkpoint_ids es JSONB (no uuid[]): un "= ANY(jsonb)"
              -- compila en TypeScript, pasa los mocks, y revienta en Postgres
              -- al EJECUTAR — tumbo guard/home entero en staging con un 500.
              -- La pertenencia a un arreglo jsonb se pregunta asi:
              AND sc.checkpoint_id::text IN (
                SELECT jsonb_array_elements_text(p.expected_checkpoint_ids)
              )
          ) AS completed_checkpoint_count,
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
                -- 'acceso_critico' es lo que hace obligatoria la foto de la
                -- puerta, y requires_photo es el override del punto. Sin
                -- mandarlos, la pantalla de terreno no tiene con que decidir y
                -- el guardia nunca se entera de que debe fotografiar.
                'kind', c.kind,
                'requiresPhoto', c.requires_photo,
                'latitude', c.latitude,
                'longitude', c.longitude,
                'tagUids', COALESCE((
                  SELECT jsonb_agg(t.uid ORDER BY t.installed_at DESC)
                  FROM tags t
                  WHERE t.tenant_id = p.tenant_id
                    AND t.checkpoint_id = c.id
                    AND t.is_active
                ), '[]'::jsonb),
                -- Hora del primer escaneo aceptado de ESTE punto en ESTA ronda,
                -- o null si sigue pendiente. Es lo que le permite al portal
                -- reconstruir la ronda tras una recarga sin fiarse solo del
                -- almacenamiento local del telefono.
                'scannedAt', (
                  SELECT min(sc.scanned_at_device)
                  FROM scans sc
                  WHERE sc.tenant_id = p.tenant_id
                    AND sc.patrol_id = p.id
                    AND sc.checkpoint_id = c.id
                )
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
        -- Se agrupa por las CLAVES PRIMARIAS (p.id, s.id, r.id): eso habilita
        -- la dependencia funcional y deja usar cualquier columna de esas tablas.
        -- Agrupar por p.site_id no sirve: es columna de patrols, no la PK de
        -- sites, y Postgres aborta con 42803 al pedir s.timezone.
        GROUP BY p.id, s.id, r.id
        ORDER BY
          CASE p.status WHEN 'en_curso' THEN 0 ELSE 1 END,
          p.scheduled_start_at DESC
        LIMIT 1
      `;

/*
 * El recinto al que se asocia un evento cuando el guardia no tiene ni ronda ni
 * jornada abierta: el caso del guardia recien dado de alta que aprieta panico.
 *
 * Dos cosas que este SQL arregla y conviene no volver a perder:
 *
 * 1. La tabla es `guard_sites` (tenant_id, guard_id, role_key, site_id).
 *    `user_sites` NO EXISTE —nunca existio en ninguna migracion— y la consulta
 *    fallaba con `42P01`, o sea un 500 en el boton de panico. El test con mock
 *    no podia verlo: devolvia la fila que el autor esperaba.
 *
 * 2. Con mas de un recinto asignado NO da igual cual se elija. La alerta se
 *    escala al supervisor de ESE recinto, asi que tomar el primero que devuelva
 *    la base es mandar el panico a quien no esta cerca. Se elige el recinto mas
 *    cercano a la posicion informada; sin coordenadas —guardia sin GPS, que es
 *    normal en un subterraneo— cae a un orden estable en vez de a uno aleatorio.
 *    Los recintos activos van primero, pero los inactivos NO se filtran: dejar
 *    un panico sin destino es peor que mandarlo a un recinto dado de baja.
 *
 * La distancia es equirectangular sobre grados, con la longitud corregida por
 * el coseno de la latitud. No es para medir, es para ordenar entre recintos que
 * estan a kilometros; el haversine de `geo/haversine.ts` es para lo otro.
 *
 * Los `::float8` no son adorno: un parametro que solo aparece dentro de un
 * `IS NULL` no le da a PostgreSQL de donde deducir el tipo y la sentencia
 * revienta con `42P08`. Ver `database/parametros-tipados.integration.spec.ts`,
 * que ejecuta ESTA misma cadena contra PostgreSQL de verdad.
 */
export const SQL_RECINTO_ASIGNADO_DEL_GUARDIA = `SELECT gs.site_id
   FROM guard_sites gs
   JOIN sites si ON si.tenant_id = gs.tenant_id AND si.id = gs.site_id
   WHERE gs.guard_id = $1
   ORDER BY
     si.is_active DESC,
     CASE
       WHEN $2::float8 IS NULL OR $3::float8 IS NULL
         OR si.latitude IS NULL OR si.longitude IS NULL THEN NULL
       ELSE (si.latitude::float8 - $2::float8) ^ 2
          + ((si.longitude::float8 - $3::float8) * cos(radians($2::float8))) ^ 2
     END ASC NULLS LAST,
     gs.created_at ASC,
     gs.site_id ASC
   LIMIT 1`;

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
    // Van al final y opcionales: varios specs construyen el servicio por posicion.
    private readonly signatures?: DeviceSignatureService,
    // Resuelve el horario habil del recinto y la foto obligatoria de un punto.
    // Es quien llama a isPhotoRequired() de @sentrycore/shared: la decision no se
    // reimplementa aca.
    private readonly evidence?: EvidenceService,
  ) {}

  async getHome(guardId: string, siteId?: string) {
    const rows = await this.tenantContext.manager.query<PatrolRow[]>(
      CONSULTA_HOME,
      [guardId],
    );

    const patrol = rows?.[0];
    if (!patrol) {
      let assignedSites: Array<{ id: string; name: string; branchName: string }> = [];
      try {
        const sitesRows = await this.tenantContext.manager.query<Array<{
          id: string;
          name: string;
          branch_name: string;
        }>>(
          `SELECT s.id, s.name, s.branch_name
           FROM guard_sites gs
           JOIN sites s ON s.id = gs.site_id AND s.is_active
           WHERE gs.guard_id = $1
           ORDER BY s.branch_name, s.name`,
          [guardId],
        );
        if (Array.isArray(sitesRows)) {
          assignedSites = sitesRows.map((s) => ({
            id: s.id,
            name: s.name,
            branchName: s.branch_name,
          }));
        }
      } catch {
        // En tests unitarios sin mock de guard_sites
      }

      return {
        hasAssignment: false as const,
        assignedSites,
        selectedSiteId: siteId ?? assignedSites[0]?.id ?? null,
        message: 'No tienes un turno asignado en este momento.',
        connection: { status: 'online' as const },
        synchronization: { pendingItems: 0 },
      };
    }

    const reglas = await this.rules.effective({ siteId: patrol.site_id });

    /*
     * Vencimiento perezoso (ver patrol-expiry.ts). Se decide AQUI, al mirarla,
     * porque este es el momento en que el estado le importa a alguien: sin
     * esto, una ronda de un turno que termino ayer sigue apareciendo como "tu
     * turno" y acepta escaneos dias despues — pasa exactamente eso en staging,
     * 48 horas en curso y cierre al 100% sin una anomalia.
     */
    if (rondaVencida(
      { status: patrol.status, startedAt: patrol.started_at, scheduledEndAt: patrol.scheduled_end_at },
      reglas,
      new Date(),
    )) {
      await this.tenantContext.manager.query(
        `UPDATE patrols SET status = 'vencida'
         WHERE id = $1 AND status IN ('pendiente', 'en_curso')`,
        [patrol.id],
      );
      return {
        hasAssignment: false as const,
        selectedSiteId: siteId ?? patrol.site_id,
        message:
          'Tu última ronda venció por tiempo y quedó cerrada. No tienes una ronda activa en este momento.',
        connection: { status: 'online' as const },
        synchronization: { pendingItems: 0 },
      };
    }

    const politicaFoto = await this.politicaDeFoto(patrol.site_id, reglas);

    let assignedSites: Array<{ id: string; name: string; branchName: string }> = [
      { id: patrol.site_id, name: patrol.site_name, branchName: '' },
    ];
    try {
      const sitesRows = await this.tenantContext.manager.query<Array<{
        id: string;
        name: string;
        branch_name: string;
      }>>(
        `SELECT s.id, s.name, s.branch_name
         FROM guard_sites gs
         JOIN sites s ON s.id = gs.site_id AND s.is_active
         WHERE gs.guard_id = $1
         ORDER BY s.branch_name, s.name`,
        [guardId],
      );
      if (Array.isArray(sitesRows) && sitesRows.length) {
        assignedSites = sitesRows.map((s) => ({
          id: s.id,
          name: s.name,
          branchName: s.branch_name,
        }));
      }
    } catch {
      // Ignora en mocks
    }

    return {
      hasAssignment: true as const,
      assignedSites,
      selectedSiteId: patrol.site_id,
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
        completedCheckpointCount: patrol.completed_checkpoint_count,
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
      /*
       * Si esta ronda admite el respaldo por QR (#227), resuelto en la cascada
       * DEL RECINTO igual que el presupuesto de la foto.
       *
       * Va en esta respuesta y no en una consulta aparte del portal porque la
       * pantalla la necesita para decidir que boton ofrece, y una segunda
       * llamada seria una segunda oportunidad de quedarse sin señal justo antes
       * de marcar un punto. Con `false` el telefono sin antena NFC queda sin
       * ningun camino a proposito: la empresa decidio que un QR no vale como
       * evidencia, y la pantalla lo dice en vez de ofrecer un boton que la API
       * va a rechazar.
       */
      qrFallbackEnabled: reglas.allowQrFallback,
      /*
       * Con que decidir, en el telefono y sin señal, en que puntos hay que
       * fotografiar. Se omite si el horario del recinto no se pudo resolver: es
       * mejor que la pantalla lo sepa y caiga en su respaldo a que reciba un
       * horario inventado y deje de pedir la foto del acceso critico.
       */
      ...(politicaFoto ? { photoPolicy: politicaFoto } : {}),
      connection: { status: 'online' as const },
      synchronization: { pendingItems: 0 },
    };
  }

  /**
   * Horario habil del recinto + las dos reglas de foto que el telefono le pasa
   * a isPhotoRequired(). El horario se evalua UNA vez, al armar la pantalla.
   *
   * Una ronda de ocho horas puede cruzar el cierre del recinto y esta foto fija
   * quedar vieja; por eso el escaneo EN LINEA devuelve `photoRequired`
   * recalculado contra el horario del momento, y ese manda sobre esto. Sin
   * señal, esta instantanea es lo unico que hay — y es infinitamente mejor que
   * lo que habia, que era nada.
   */
  private async politicaDeFoto(
    siteId: string,
    reglas: PatrolRules,
  ): Promise<PoliticaDeFoto | undefined> {
    if (!this.evidence) return undefined;
    try {
      return {
        withinBusinessHours: await this.evidence.isWithinBusinessHours(siteId),
        evaluatedAt: new Date().toISOString(),
        rules: {
          photoRequiredOutsideHours: reglas.photoRequiredOutsideHours,
          photoRequiredOnCritical: reglas.photoRequiredOnCritical,
        },
      };
    } catch (error) {
      // La pantalla del turno no se cae por no poder resolver el horario.
      this.logger.warn(
        JSON.stringify({
          event: 'politica_foto_no_resuelta',
          site_id: siteId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return undefined;
    }
  }

  /**
   * ¿Este punto exige foto AHORA? Lo resuelve EvidenceService con el horario
   * real del recinto y isPhotoRequired() de @sentrycore/shared; aca no se recalcula
   * nada.
   *
   * `null` = no se pudo resolver, y entonces el telefono decide con la politica
   * que le llego en `GET /guard/home`. Un fallo consultando la foto NO puede
   * tumbar el escaneo: el punto ya quedo registrado y eso es lo que no se puede
   * perder.
   */
  private async exigeFoto(checkpointId: string): Promise<boolean | null> {
    if (!this.evidence) return null;
    try {
      return (await this.evidence.requiresPhoto(checkpointId)).required;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'foto_obligatoria_no_resuelta',
          checkpoint_id: checkpointId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
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
   * Guarda un escaneo que llego DIRECTO sobre una ronda ya cerrada y corta con
   * el mensaje que redacta late-scan.policy.ts. Es el espejo del camino de la
   * cola (sync.service.ts): mismo criterio, misma tabla, misma clave de
   * idempotencia — reenviar no duplica.
   *
   * La correccion por desfase de reloj vive solo en el camino de la cola, donde
   * el escaneo puede llegar horas despues y el desfase importa. Aca llega en
   * vivo: se toma la hora del dispositivo si viene y es sensata, y si no, la
   * del servidor. Un atraso de horas domina cualquier desfase de minutos.
   */
  private async preservarEscaneoAtrasado(
    patrol: { id: string; scheduled_end_at: Date; closed_at: Date | null },
    estado: EstadoDeRondaCerrada,
    guardId: string,
    input: CreateScanDto,
    graciaMin: number,
  ): Promise<never> {
    const delDispositivo = input.scannedAt ? new Date(input.scannedAt) : null;
    const esSensata =
      delDispositivo !== null &&
      !Number.isNaN(delDispositivo.getTime()) &&
      delDispositivo.getTime() <= Date.now();
    const instante = esSensata && delDispositivo !== null ? delDispositivo : new Date();

    const veredicto = evaluarEscaneoAtrasado(
      { status: estado, closedAt: patrol.closed_at, scheduledEndAt: patrol.scheduled_end_at },
      instante,
      graciaMin,
    );

    // Mismas columnas y misma clave que sync-conflicts.service.ts: los dos
    // caminos terminan en la misma bandeja del supervisor (#222).
    await this.tenantContext.manager.query(
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
       ON CONFLICT (tenant_id, patrol_id, client_scan_id) DO NOTHING`,
      [
        patrol.id,
        guardId,
        input.clientScanId,
        input.uid.trim(),
        input.method,
        estado,
        veredicto.clasificacion,
        veredicto.minutosDeAtraso,
        graciaMin,
        input.scannedAt ?? null,
        instante,
        esSensata ? 'dispositivo' : 'servidor',
        null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.accuracyM ?? null,
      ],
    );

    throw new ConflictException(veredicto.mensaje);
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
      site_id: string;
      started_at: Date | null;
      scheduled_start_at: Date;
      scheduled_end_at: Date;
      closed_at: Date | null;
    }>>(
      `SELECT id, status, route_id, expected_checkpoint_ids,
              site_id, started_at, scheduled_start_at, scheduled_end_at, closed_at
       FROM patrols WHERE id = $1 AND guard_id = $2`,
      [patrolId, guardId],
    );
    const patrol = patrols[0];
    if (!patrol) throw new NotFoundException('La ronda asignada no existe');

    // Reglas del RECINTO de la ronda. Antes esto se resolvia mas abajo y SIN
    // contexto de sitio, o sea con la cascada cortada en el tenant: un recinto
    // con su propio radio de GPS o su propia tolerancia de reloj no las veia.
    const reglasDelRecinto = await this.rules.effective({ siteId: patrol.site_id });

    // Vencimiento perezoso (ver patrol-expiry.ts): la ronda que quedo abierta
    // de un turno pasado se vence en el momento en que alguien la toca.
    let estado = patrol.status;
    if (
      (estado === 'pendiente' || estado === 'en_curso') &&
      rondaVencida(
        { status: estado, startedAt: patrol.started_at, scheduledEndAt: patrol.scheduled_end_at },
        reglasDelRecinto,
        new Date(),
      )
    ) {
      await this.tenantContext.manager.query(
        `UPDATE patrols SET status = 'vencida'
         WHERE id = $1 AND status IN ('pendiente', 'en_curso')`,
        [patrolId],
      );
      estado = 'vencida';
    }

    if (esRondaCerrada(estado)) {
      /*
       * Antes aca habia un 409 pelado ("La ronda ya está cerrada") y el escaneo
       * SE PERDIA. Eso dejaba una asimetria absurda: el mismo escaneo tardio,
       * llegando por la cola offline, quedaba preservado en late_scans con su
       * clasificacion — pero llegando en vivo, con señal, se tiraba a la
       * basura. El guardia CON señal era el que perdia su registro.
       *
       * Ahora los dos caminos terminan igual: el escaneo queda guardado como
       * marca atrasada, el supervisor lo revisa, y el guardia recibe el mismo
       * mensaje que redacta late-scan.policy.ts.
       */
      await this.preservarEscaneoAtrasado(
        patrol, estado, guardId, input, reglasDelRecinto.lateScanGraceMin,
      );
    }

    // El primer escaneo inicia la ronda si venia pendiente: en terreno el
    // guardia escanea, no aprieta botones.
    if (patrol.status === 'pendiente') {
      // La MISMA puerta que `startPatrol()`. Si el arranque automatico no la
      // aplicara, el aviso de geolocalizacion no valdria nada: bastaria no
      // apretar "Iniciar ronda" y escanear directo para que el sistema empiece
      // a guardar la ubicacion de un trabajador que nunca lo acepto. Comprobado
      // contra staging: con el consentimiento en `nunca_aceptado`, `start`
      // respondia 403 y el escaneo respondia 200 igual.
      //
      // Va solo en el arranque, no en cada escaneo, y a proposito: una ronda ya
      // empezada paso por esta puerta, y cortarla a mitad de camino en terreno
      // perderia la evidencia de lo que el guardia ya recorrio.
      await this.gpsPolicy.assertPatrolStartAllowed(guardId, patrolId);
      await this.tenantContext.manager.query(
        `UPDATE patrols SET status = 'en_curso', started_at = now()
         WHERE id = $1 AND status = 'pendiente'`,
        [patrolId],
      );
    }

    const rawUid = input.uid.trim();
    const normalizedNfcUid = normalizarUidNfc(rawUid);

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
       WHERE (
         tag.uid = $1
         OR tag.uid = $3
         OR (tag.tech = 'nfc' AND UPPER(REGEXP_REPLACE(tag.uid, '[^0-9A-Fa-f]', '', 'g')) = $3)
       ) AND tag.is_active`,
      [rawUid, patrol.route_id, normalizedNfcUid],
    );
    const target = resolved[0];
    if (!target) throw new NotFoundException('La etiqueta no resuelve a ningún punto');
    if (!patrol.expected_checkpoint_ids.includes(target.checkpoint_id)) {
      throw new ConflictException('El punto escaneado no pertenece a esta ronda');
    }

    // Reglas efectivas del RECINTO (#16), resueltas una sola vez al entrar al
    // escaneo. Antes aca habia un `effective()` sin contexto de sitio: un
    // recinto con su propio radio GPS o su propia tolerancia de reloj no las
    // veia — la cascada quedaba cortada en el tenant.
    const rules = reglasDelRecinto;
    const anomalies: ScanAnomaly[] = [];
    if (estadoFirma === 'legacy') anomalies.push('firma_dispositivo_ausente');
    if (input.latitude === undefined || input.longitude === undefined) {
      if (rules.gpsSharingMandatory) anomalies.push('sin_fix_gps');
    } else if (target.latitude !== null && target.longitude !== null) {
      const distanceM = haversineM(
        input.latitude, input.longitude,
        Number(target.latitude), Number(target.longitude),
      );
      if (distanceM > rules.gpsValidationRadiusM) anomalies.push('fuera_de_radio_gps');
    }
    if (input.scannedAt) {
      // La tolerancia sale de la regla, no de un numero escrito aca. Estaba
      // fijo en 5 minutos y `SyncService` ya usaba `clockSkewToleranceMin` para
      // ESTA misma comprobacion: el mismo escaneo salia marcado o limpio segun
      // por donde entrara. No se notaba porque el default de la regla tambien es
      // 5 — se habria notado el dia que un admin la cambiara, que es cuando peor
      // se nota, porque el panel diria una cosa y el informe otra.
      const driftMs = Math.abs(Date.now() - new Date(input.scannedAt).getTime());
      if (driftMs > rules.clockSkewToleranceMin * 60_000) anomalies.push('reloj_desfasado');
    }
    /*
     * (B5) Fuera de la ventana del turno. Existia todo el catalogo de anomalias
     * y ninguna miraba el RELOJ DEL TURNO: un turno de 22:00-06:00 escaneado a
     * mediodia del dia siguiente pasaba limpio — comprobado en staging con una
     * ronda real, que ademas se habia INICIADO 10 horas antes de su ventana sin
     * que nada lo marcara.
     *
     * La gracia es la misma del escaneo tardio (`lateScanGraceMin`), a ambos
     * lados: llegar un poco antes o salir un poco despues es terreno normal.
     * El vencimiento por duracion (patrol-expiry.ts) cubre otra cosa — una
     * ronda ABIERTA demasiado tiempo; esto marca el escaneo puntual que cae
     * fuera del horario aunque la ronda este viva y sana. Marca, no rechaza.
     */
    if (patrol.scheduled_start_at && patrol.scheduled_end_at) {
      const margenMs = rules.lateScanGraceMin * 60_000;
      const delDispositivo = input.scannedAt ? new Date(input.scannedAt) : null;
      const sensata =
        delDispositivo !== null &&
        !Number.isNaN(delDispositivo.getTime()) &&
        delDispositivo.getTime() <= Date.now();
      const instante = sensata && delDispositivo !== null ? delDispositivo : new Date();
      if (
        instante.getTime() < patrol.scheduled_start_at.getTime() - margenMs ||
        instante.getTime() > patrol.scheduled_end_at.getTime() + margenMs
      ) {
        anomalies.push('fuera_de_turno');
      }
    }

    /*
     * (#60) Las dos anomalias de SECUENCIA, que estaban declaradas en el
     * catalogo con CERO escritores — y son literalmente el antifraude del
     * producto: el guardia que escanea las etiquetas todas juntas desde la
     * caseta, y el que le presta el telefono a un compañero.
     *
     * La consulta trae los escaneos previos de la ronda con las coordenadas de
     * SU punto. La velocidad se mide entre puntos (fijos) con hora del SERVIDOR
     * en ambos extremos — ni el GPS impreciso ni el reloj del telefono pueden
     * fabricarla ni taparla. Ver anomalias-de-secuencia.ts.
     *
     * Corre antes del INSERT a proposito: el nuevo escaneo no esta en la lista
     * y no se compara consigo mismo. Un replay (ON CONFLICT DO NOTHING) no
     * llega a doble-marcar porque el INSERT no devuelve fila y el escaneo
     * original conserva sus anomalias de la primera vez.
     */
    const escaneosPrevios = filasDe<{
      scanned_at_server: Date;
      device_id: string | null;
      latitude: string | null;
      longitude: string | null;
    }>(
      await this.tenantContext.manager.query(
        `SELECT sc.scanned_at_server, sc.device_id, c.latitude, c.longitude
         FROM scans sc
         JOIN checkpoints c ON c.tenant_id = sc.tenant_id AND c.id = sc.checkpoint_id
         WHERE sc.tenant_id = app_tenant_id() AND sc.patrol_id = $1
         ORDER BY sc.scanned_at_server DESC`,
        [patrolId],
      ),
    );
    if (escaneosPrevios.length > 0) {
      const ultimo = escaneosPrevios[0]!;
      if (
        velocidadImposible(
          {
            latitude: ultimo.latitude === null ? null : Number(ultimo.latitude),
            longitude: ultimo.longitude === null ? null : Number(ultimo.longitude),
            at: new Date(ultimo.scanned_at_server),
          },
          {
            latitude: target.latitude === null ? null : Number(target.latitude),
            longitude: target.longitude === null ? null : Number(target.longitude),
            at: new Date(),
          },
          rules.impossibleSpeedKmh,
        )
      ) {
        anomalies.push('velocidad_imposible');
      }
      if (dispositivoDuplicado(escaneosPrevios.map((p) => p.device_id), input.deviceId ?? null)) {
        anomalies.push('dispositivo_duplicado');
      }
    }

    /*
     * El veredicto de la foto se resuelve ANTES de escribir, y no es un detalle
     * de orden: `exigeFoto()` hace un SELECT y se traga su error para no tumbar
     * el escaneo. Pero tragarse la excepcion de JavaScript NO desaborta una
     * transaccion que PostgreSQL ya marco, y todo el request corre dentro de
     * UNA (tenant-context.interceptor.ts).
     *
     * Puesto despues del INSERT y del cierre —donde estaba— la secuencia era:
     * se inserta el escaneo, se cierra la ronda, se ENCOLA el informe, falla el
     * SELECT, el catch lo silencia, y el commit revienta con 25P02. Resultado:
     * el guardia recibe 500 y vuelve a escanear, el escaneo se deshizo... y el
     * correo con el informe ya habia salido.
     *
     * Aca adelante, si falla, no hay nada escrito que perder.
     */
    const photoRequired = await this.exigeFoto(target.checkpoint_id);

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

    // Se piden tambien id y client_scan_id: el telefono necesita el id del
    // escaneo para colgarle la foto (POST /evidence/scans/:scanId/photos), y en
    // un reenvio el INSERT no devuelve nada. Sacarlo de esta consulta, que ya se
    // hacia, evita un viaje mas a la base en el camino mas caliente del
    // producto.
    const allScans = await this.tenantContext.manager.query<Array<{
      id: string;
      checkpoint_id: string;
      client_scan_id: string;
      anomalies: ScanAnomaly[];
      scanned_at_server: Date;
    }>>(
      `SELECT id, checkpoint_id, client_scan_id, anomalies, scanned_at_server
       FROM scans WHERE patrol_id = $1`,
      [patrolId],
    );
    const scanId =
      inserted[0]?.id ??
      allScans.find((s) => s.client_scan_id === input.clientScanId)?.id ??
      null;

    /*
     * (B9) ¿Este punto YA estaba marcado en esta ronda por OTRO escaneo?
     *
     * No es el replay: el replay es el MISMO escaneo reenviado (mismo
     * clientScanId) y no crea fila. Esto es el guardia pasando la etiqueta de
     * un punto que ya marco hace un rato — la fila nueva se conserva (marca,
     * no rechaza), pero antes el telefono no recibia ninguna señal y el
     * guardia no sabia si el primero habia contado. Se avisa con la hora del
     * primero, que es la que vale para el informe.
     */
    const previos = allScans.filter(
      (s) => s.checkpoint_id === target.checkpoint_id && s.client_scan_id !== input.clientScanId,
    );
    const primerEscaneo = previos.reduce<Date | null>(
      (min, s) => (min === null || s.scanned_at_server < min ? s.scanned_at_server : min),
      null,
    );
    const alreadyScanned = !replay && previos.length > 0;
    const compliance = computeCompliance(
      patrol.expected_checkpoint_ids,
      allScans.map((s) => ({ checkpointId: s.checkpoint_id, anomalies: s.anomalies })),
      rules.complianceThreshold,
    );

    // El escaneo del punto de cierre cierra la ronda, este o no completa — pero
    // el ESTADO dice la verdad. Antes aca se escribia 'completada'
    // incondicional: una ronda cerrada al 40% quedaba con la misma palabra que
    // una al 100%, y 'incompleta' era un estado que existia en el CHECK, en las
    // estadisticas y en los informes sin que nadie lo escribiera jamas. El
    // porcentaje real quedaba guardado, pero la palabra que lee el admin mentia.
    let closed = false;
    if (target.is_closing_point && !replay) {
      await this.tenantContext.manager.query(
        `UPDATE patrols
         SET status = CASE WHEN $2 >= 100 THEN 'completada' ELSE 'incompleta' END,
             closed_at = now(), compliance_pct = $2
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
      /** El punto ya tenia OTRO escaneo en esta ronda; este quedo igual (marca, no rechaza). */
      alreadyScanned,
      firstScannedAt: alreadyScanned ? primerEscaneo : null,
      alertSent: closed && compliance.belowThreshold,
      // El id del escaneo recien creado (o el del original, si esto fue un
      // reenvio). Es donde el telefono cuelga la foto del punto.
      scanId,
      checkpoint: {
        id: target.checkpoint_id,
        name: target.checkpoint_name,
        kind: target.kind,
        // Veredicto del servidor, con el horario del recinto en ESTE instante.
        // `null` = no se pudo resolver y decide el telefono con su politica.
        photoRequired,
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
        // El MISMO criterio que el UPDATE de arriba: si divergieran, el telefono
        // mostraria "completada" mientras la base dice "incompleta".
        status: closed ? (compliance.pct >= 100 ? 'completada' : 'incompleta') : 'en_curso',
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
    /*
     * `filasDe` porque un UPDATE pelado devuelve [filas, rowCount]: `filas[0]`
     * era el ARREGLO de filas —truthy aunque venga vacio—, asi que marcar salida
     * sin jornada abierta respondia 200 con `assignmentId: undefined` en vez del
     * 409. startPatrol() resuelve lo mismo envolviendo el UPDATE en un CTE; aca
     * se deja el SQL intacto porque no habia como correrlo contra Postgres.
     */
    const filas = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
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
      ),
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
    let patrol: { id: string | null; site_id: string } | undefined;
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
        // Si el guardia no tiene rondas registradas aun, se asocia el evento al
        // recinto de su jornada activa (shift_assignments en curso) o recinto asignado.
        const shiftRows = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
          `SELECT s.site_id
           FROM shift_assignments a
           JOIN shifts s ON s.id = a.shift_id
           WHERE a.guard_id = $1 AND a.status = 'en_curso'
           ORDER BY a.started_at DESC
           LIMIT 1`,
          [guardId],
        );
        if (shiftRows[0]?.site_id) {
          patrol = { id: null, site_id: shiftRows[0].site_id };
        } else {
          const guardSiteRows = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
            SQL_RECINTO_ASIGNADO_DEL_GUARDIA,
            [guardId, input.latitude ?? null, input.longitude ?? null],
          );
          if (guardSiteRows[0]?.site_id) {
            patrol = { id: null, site_id: guardSiteRows[0].site_id };
          } else {
            throw new ConflictException('No hay una ronda o recinto que asocie el evento');
          }
        }
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
