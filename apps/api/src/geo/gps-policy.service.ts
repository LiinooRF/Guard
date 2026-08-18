import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PatrolRules } from '@sentrycore/shared';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import {
  ESTADOS_QUE_COMPARTEN,
  type GpsPermissionState,
  type GpsPermissionStateOrMissing,
  type ReportGpsPermissionDto,
} from './dto/gps-permission.dto';
import { planDeMuestreo, type GpsSamplingPlan } from './gps-rules';

/** Obligatorio u opcional. Es el flag por tenant que pide el issue #77. */
export type GpsSharingMode = 'obligatorio' | 'opcional';

export type GpsBlockedReason =
  | 'sin_consentimiento'
  | 'permiso_denegado'
  | 'sin_reporte_de_permiso';

/**
 * Ventana minima para que un consumo de bateria signifique algo.
 *
 * No es una regla de negocio, es un piso de medicion: con 3 minutos de traza,
 * un 1% de caida proyecta 20% por hora y el informe diria cualquier cosa. Por
 * eso no vive en rules.ts — configurarlo no cambia ninguna politica de la
 * empresa, solo permitiria publicar un numero sin sentido.
 */
const MINIMO_MEDIBLE_MIN = 15;

/**
 * Puntos porcentuales de tolerancia para dar por recargado el telefono. Los
 * equipos reportan la bateria en escalones y un +1 no es un cargador.
 */
const TOLERANCIA_RECARGA_PCT = 2;

const MENSAJES = {
  sin_consentimiento:
    'Para iniciar la ronda tienes que aceptar el aviso de compartir ubicación.',
  permiso_denegado:
    'Esta empresa exige compartir la ubicación durante la ronda. Activa el permiso de ubicación del teléfono y vuelve a intentar.',
  sin_reporte_de_permiso:
    'El teléfono todavía no confirmó el permiso de ubicación. Abre la app, revisa el permiso y vuelve a intentar.',
  seguimiento_apagado:
    'Esta empresa no registra el recorrido: puedes hacer la ronda con normalidad.',
  opcional_sin_gps:
    'Compartir tu ubicación es opcional en esta empresa. Puedes hacer la ronda igual; no se registrará tu recorrido.',
  registrando:
    'Tu recorrido se registra solo mientras la ronda está en curso.',
} as const;

interface FilaConsentimiento {
  granted_at: Date;
  policy_version: string;
}

interface FilaPermiso {
  status: GpsPermissionState;
  reported_at: Date;
}

interface FilaBateria {
  total_points: number;
  battery_points: number;
  first_at: Date | null;
  last_at: Date | null;
  battery_first_at: Date | null;
  battery_last_at: Date | null;
  min_pct: number | null;
  max_pct: number | null;
  first_pct: number | null;
  last_pct: number | null;
}

interface FilaCobertura {
  service_day: string;
  rondas: number;
  con_traza: number;
}

export interface GpsPolicy {
  siteId: string | null;
  mode: GpsSharingMode;
  trackingEnabled: boolean;
  sampling: GpsSamplingPlan;
  retentionDays: number;
  batteryBudgetPct: number;
  referenceHours: number;
  consent: {
    granted: boolean;
    grantedAt: Date | null;
    policyVersion: string | null;
  };
  permission: {
    status: GpsPermissionStateOrMissing;
    reportedAt: Date | null;
    stale: boolean;
  };
  /** true si con este estado se van a guardar puntos de recorrido. */
  tracksLocation: boolean;
  canStartPatrol: boolean;
  blockedReason: GpsBlockedReason | null;
  /** Texto listo para mostrarle al guardia. */
  message: string;
}

/**
 * GPS obligatorio configurable (#77).
 *
 * TRES DECISIONES QUE CONVIENE ENTENDER ANTES DE TOCAR ESTO
 * --------------------------------------------------------
 * 1. OPCIONAL NO ES APAGADO. `gpsSharingMandatory` decide si se puede o no
 *    trabajar sin compartir ubicacion. Quien acepta compartirla queda con
 *    recorrido registrado en los dos modos. El interruptor de "esta empresa no
 *    rastrea a nadie" es `gpsTrackingEnabled`, aparte.
 *
 * 2. EL CONSENTIMIENTO Y EL PERMISO SON COSAS DISTINTAS. El consentimiento es la
 *    evidencia legal de que al trabajador se le informo (#15); el permiso es el
 *    interruptor del sistema operativo. Se puede tener lo primero y no lo
 *    segundo, y en modo obligatorio ninguno de los dos alcanza solo.
 *
 * 3. LA DECISION SE GUARDA. Cada evaluacion deja fila en `patrol_gps_gate`. Una
 *    ronda sin recorrido no se explica sola: sin ese registro no se distingue al
 *    guardia que ejercio una opcion que la empresa le dio, del telefono que se
 *    quedo sin bateria.
 *
 * Este servicio NO toca `guard.service.ts`. El bloqueo real del arranque lo
 * aplica `assertPatrolStartAllowed()`, que el integrador enchufa en
 * `GuardService.startPatrol()` (ver INTEGRACION.md).
 */
@Injectable()
export class GpsPolicyService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly supervisor: SupervisorService,
  ) {}

  /**
   * El telefono informa en que estado quedo su permiso de ubicacion.
   *
   * Una fila por persona: lo unico que decide el arranque es el estado de ahora.
   *
   * `INSERT ... ON CONFLICT DO UPDATE` conserva el command tag INSERT, asi que
   * el driver devuelve las filas del RETURNING planas. Un UPDATE pelado no: ahi
   * devuelve [filas, rowCount] y habria que envolverlo en un CTE como hace
   * GuardService.startPatrol().
   */
  async reportPermission(userId: string, input: ReportGpsPermissionDto) {
    const filas = await this.tenantContext.manager.query<
      Array<{ status: GpsPermissionState; reported_at: Date }>
    >(
      `INSERT INTO gps_permission_reports (tenant_id, user_id, status, device_info)
       VALUES (app_tenant_id(), $1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         status = EXCLUDED.status,
         device_info = EXCLUDED.device_info,
         reported_at = now()
       RETURNING status, reported_at`,
      [userId, input.status, input.deviceInfo ?? null],
    );
    const guardado = filas[0];
    return {
      status: guardado?.status ?? input.status,
      reportedAt: guardado?.reported_at ?? null,
      sharesLocation: ESTADOS_QUE_COMPARTEN.includes(input.status),
    };
  }

  /**
   * Politica vigente para esta persona, resuelta en la cascada del recinto.
   *
   * Es lo que la app consulta al abrir y al iniciar cada ronda: por eso el
   * cambio que hace el admin aplica sin actualizar la app. Aca no hay ni un
   * numero fijo; todo sale de las reglas efectivas.
   */
  async policy(userId: string, siteId?: string | null): Promise<GpsPolicy> {
    const reglas = await this.rules.effective(siteId ? { siteId } : {});
    const estado = await this.estadoDe(userId);
    return this.armar(reglas, estado, siteId ?? null);
  }

  /**
   * Chequeo previo al inicio de la ronda. El telefono manda su estado de permiso
   * y el servidor responde si puede arrancar.
   *
   * Responde 200 aunque este bloqueado, con motivo y mensaje: la app tiene que
   * poder mostrar la pantalla correcta ("acepta el aviso", "activa el permiso")
   * y no un error generico. El 403 lo tira el arranque de verdad.
   */
  async patrolStartCheck(guardId: string, patrolId: string, input: ReportGpsPermissionDto) {
    await this.reportPermission(guardId, input);
    return this.evaluarInicio(guardId, patrolId, false);
  }

  /**
   * Punto de enganche para `GuardService.startPatrol()`.
   *
   * Con GPS obligatorio y sin ubicacion compartida, la ronda NO arranca: 403.
   * Con GPS opcional deja pasar siempre y solo deja registrado que se trabajo
   * sin recorrido.
   */
  async assertPatrolStartAllowed(guardId: string, patrolId: string) {
    return this.evaluarInicio(guardId, patrolId, true);
  }

  /**
   * Lo mismo, pero SIN bloquear: evalua y deja la decision escrita.
   *
   * Es lo que corresponde en el arranque IMPLICITO —el primer escaneo de una
   * ronda pendiente, que tambien la pone en curso— y en la sincronizacion
   * offline. Ahi el trabajo ya se hizo en terreno: rechazarlo destruye evidencia
   * de una ronda que fisicamente ocurrio, y el sistema marca y avisa, no
   * rechaza. La ronda queda registrada como iniciada sin ubicacion compartida y
   * el supervisor lo ve.
   */
  async recordPatrolStart(guardId: string, patrolId: string) {
    return this.evaluarInicio(guardId, patrolId, false);
  }

  /**
   * Consumo de bateria de una ronda, medido con los propios puntos de la traza
   * (`patrol_tracks.battery_pct`).
   *
   * Existe para que "una ronda de 8 horas consume menos del 20%" sea algo que se
   * MIDE en produccion y no una promesa del cliente movil. El presupuesto es
   * configurable (`gpsBatteryBudgetPct`) y la referencia de duracion sale de
   * `maxPatrolDurationMin`, que ya es la duracion maxima de ronda del tenant.
   */
  async patrolBattery(patrolId: string, requester: Pick<AuthenticatedUser, 'sub' | 'role'>) {
    const rondas = await this.tenantContext.manager.query<
      Array<{
        id: string;
        site_id: string;
        guard_id: string;
        status: string;
        started_at: Date | null;
        closed_at: Date | null;
      }>
    >(
      `SELECT id, site_id, guard_id, status, started_at, closed_at
       FROM patrols WHERE id = $1`,
      [patrolId],
    );
    const ronda = rondas[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados: el permiso no
    // alcanza. Se reusa el control de SupervisorService en vez de repetirlo.
    if (requester.role === 'SUPERVISOR') {
      await this.supervisor.ensureAssignedSite(ronda.site_id, requester.sub);
    }

    const reglas = await this.rules.effective({ siteId: ronda.site_id });
    const plan = planDeMuestreo(reglas);

    const filas = await this.tenantContext.manager.query<FilaBateria[]>(
      `SELECT count(*)::int AS total_points,
              count(*) FILTER (WHERE battery_pct IS NOT NULL)::int AS battery_points,
              min(recorded_at_device) AS first_at,
              max(recorded_at_device) AS last_at,
              -- La ventana de la MEDICION no es la de la traza: si los primeros
              -- puntos vinieron sin bateria, dividir el consumo por el largo
              -- total daria un consumo por hora mas bajo que el real.
              min(recorded_at_device) FILTER (WHERE battery_pct IS NOT NULL) AS battery_first_at,
              max(recorded_at_device) FILTER (WHERE battery_pct IS NOT NULL) AS battery_last_at,
              min(battery_pct)::int AS min_pct,
              max(battery_pct)::int AS max_pct,
              (array_agg(battery_pct ORDER BY recorded_at_device)
                 FILTER (WHERE battery_pct IS NOT NULL))[1]::int AS first_pct,
              (array_agg(battery_pct ORDER BY recorded_at_device DESC)
                 FILTER (WHERE battery_pct IS NOT NULL))[1]::int AS last_pct
       FROM patrol_tracks
       WHERE patrol_id = $1`,
      [patrolId],
    );
    // Una agregacion sin GROUP BY siempre devuelve una fila, aunque no haya
    // puntos: ahi los conteos vienen en 0 y el resto en NULL.
    const fila = filas[0];

    const muestras = Number(fila?.total_points ?? 0);
    const minutos = minutosEntre(fila?.first_at, fila?.last_at);
    const minutosBateria = minutosEntre(fila?.battery_first_at, fila?.battery_last_at);

    const inicioPct = numeroONulo(fila?.first_pct);
    const finPct = numeroONulo(fila?.last_pct);
    const maximoPct = numeroONulo(fila?.max_pct);
    const consumo = inicioPct !== null && finPct !== null ? inicioPct - finPct : null;

    // Telefono enchufado a mitad de turno: la caida deja de medir el costo del
    // seguimiento y proyectarla seria inventar.
    const recargado =
      maximoPct !== null && inicioPct !== null && maximoPct > inicioPct + TOLERANCIA_RECARGA_PCT;

    const medible =
      consumo !== null && consumo >= 0 && !recargado && minutosBateria >= MINIMO_MEDIBLE_MIN;
    const porHora = medible && consumo !== null ? consumo / (minutosBateria / 60) : null;

    const horasReferencia = reglas.maxPatrolDurationMin / 60;
    const proyectado = porHora === null ? null : redondear(porHora * horasReferencia);

    // Cuantos puntos deberia haber mandado el telefono en esa ventana. Muy por
    // debajo = el sistema durmio la app, no que el guardia se haya quedado
    // quieto.
    const esperados =
      minutos > 0 ? Math.floor((minutos * 60) / plan.intervalSeconds) + 1 : muestras;

    return {
      patrolId,
      siteId: ronda.site_id,
      guardId: ronda.guard_id,
      status: ronda.status,
      startedAt: ronda.started_at,
      closedAt: ronda.closed_at,
      sampling: plan,
      trackMinutes: redondear(minutos),
      samples: muestras,
      expectedSamples: esperados,
      sampleCoveragePct: esperados > 0 ? redondear((muestras / esperados) * 100) : null,
      samplesWithBattery: Number(fila?.battery_points ?? 0),
      batteryStartPct: inicioPct,
      batteryEndPct: finPct,
      batteryMinPct: numeroONulo(fila?.min_pct),
      rechargedDuringPatrol: recargado,
      drainPct: consumo,
      drainPctPerHour: porHora === null ? null : redondear(porHora),
      referenceHours: horasReferencia,
      projectedDrainPct: proyectado,
      budgetPct: reglas.gpsBatteryBudgetPct,
      withinBudget: proyectado === null ? null : proyectado <= reglas.gpsBatteryBudgetPct,
      measurable: medible,
    };
  }

  /**
   * Cuantas rondas del recinto quedaron con recorrido registrado, dia por dia.
   *
   * Es la prueba de que el flag hace algo: el admin prende "GPS obligatorio" y
   * esta serie tiene que irse a 100%.
   *
   * EL DIA ES EL DEL RECINTO, NO EL DEL SERVIDOR. Se reusa
   * `app_stats_service_day()` (migracion 1725289200000), que resuelve al
   * `service_date` del turno cuando la ronda cuelga de uno —la ronda de las
   * 02:00 del turno del viernes es del VIERNES— y si no, al dia calendario en la
   * zona del recinto. Y la suma de dias se aplica al timestamp SIN zona ANTES de
   * convertir: al reves serian 24 horas fijas y la noche del cambio de horario
   * correria el corte una hora.
   */
  async siteGpsCoverage(
    siteId: string,
    days: number,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'>,
  ) {
    if (requester.role === 'SUPERVISOR') {
      await this.supervisor.ensureAssignedSite(siteId, requester.sub);
    }

    const recintos = await this.tenantContext.manager.query<
      Array<{ id: string; name: string; timezone: string }>
    >(`SELECT id, name, timezone FROM sites WHERE id = $1`, [siteId]);
    const recinto = recintos[0];
    if (!recinto) throw new NotFoundException('El recinto no existe');

    const filas = await this.tenantContext.manager.query<FilaCobertura[]>(
      `
        WITH rango AS (
          SELECT $2::text AS tz,
                 ((now() AT TIME ZONE $2::text)::date - ($3::int - 1)) AS desde,
                 (now() AT TIME ZONE $2::text)::date AS hasta
        ),
        dias AS (
          SELECT g.dia::date AS dia
          FROM rango
          CROSS JOIN LATERAL generate_series(
            rango.desde::timestamp, rango.hasta::timestamp, INTERVAL '1 day'
          ) AS g(dia)
        ),
        rondas AS (
          SELECT app_stats_service_day(p.scheduled_start_at, a.service_date, rango.tz) AS dia,
                 p.id AS patrol_id,
                 EXISTS (
                   SELECT 1 FROM patrol_tracks t
                   WHERE t.tenant_id = p.tenant_id AND t.patrol_id = p.id
                 ) AS con_traza
          FROM rango
          CROSS JOIN patrols p
          LEFT JOIN shift_assignments a
            ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
          WHERE p.site_id = $1::uuid
            AND p.scheduled_start_at >=
                ((rango.desde::timestamp - INTERVAL '1 day') AT TIME ZONE rango.tz)
            AND p.scheduled_start_at <
                ((rango.hasta::timestamp + INTERVAL '2 days') AT TIME ZONE rango.tz)
        )
        -- El dia sale como TEXTO a proposito. El driver convierte una columna
        -- date a un Date de JavaScript a medianoche LOCAL DEL SERVIDOR, y al
        -- serializarlo a ISO un servidor en UTC+X devolveria el dia anterior.
        -- Todo el trabajo de resolver el dia del recinto se perderia en la
        -- ultima linea.
        SELECT to_char(d.dia, 'YYYY-MM-DD') AS service_day,
               count(r.patrol_id)::int AS rondas,
               count(*) FILTER (WHERE r.con_traza)::int AS con_traza
        FROM dias d
        LEFT JOIN rondas r ON r.dia = d.dia
        GROUP BY d.dia
        ORDER BY d.dia
      `,
      [siteId, recinto.timezone, days],
    );

    const dias = filas.map((f) => {
      const rondas = Number(f.rondas);
      const conTraza = Number(f.con_traza);
      return {
        serviceDay: f.service_day,
        patrols: rondas,
        withTrack: conTraza,
        withoutTrack: rondas - conTraza,
        coveragePct: rondas > 0 ? redondear((conTraza / rondas) * 100) : null,
      };
    });

    const reglas = await this.rules.effective({ siteId });
    const totalRondas = dias.reduce((suma, dia) => suma + dia.patrols, 0);
    const totalConTraza = dias.reduce((suma, dia) => suma + dia.withTrack, 0);

    return {
      siteId,
      siteName: recinto.name,
      timezone: recinto.timezone,
      days,
      mode: modoDe(reglas),
      trackingEnabled: reglas.gpsTrackingEnabled,
      patrols: totalRondas,
      withTrack: totalConTraza,
      coveragePct: totalRondas > 0 ? redondear((totalConTraza / totalRondas) * 100) : null,
      series: dias,
    };
  }

  // ------------------------------------------------------------------ interno

  private async estadoDe(userId: string) {
    // El indice parcial gps_consents_active_idx garantiza a lo mas uno vigente.
    const consentimientos = await this.tenantContext.manager.query<FilaConsentimiento[]>(
      `SELECT granted_at, policy_version
       FROM gps_consents
       WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    );
    const permisos = await this.tenantContext.manager.query<FilaPermiso[]>(
      `SELECT status, reported_at FROM gps_permission_reports WHERE user_id = $1`,
      [userId],
    );
    return {
      consentimiento: consentimientos[0] ?? null,
      permiso: permisos[0] ?? null,
    };
  }

  private armar(
    reglas: PatrolRules,
    estado: { consentimiento: FilaConsentimiento | null; permiso: FilaPermiso | null },
    siteId: string | null,
  ): GpsPolicy {
    const modo = modoDe(reglas);

    const reportadoEn = estado.permiso ? new Date(estado.permiso.reported_at) : null;
    const vencido =
      reportadoEn !== null &&
      Date.now() - reportadoEn.getTime() > reglas.gpsPermissionReportMaxAgeMin * 60_000;

    // Un reporte vencido se trata como no reportado: da lo mismo que hace tres
    // semanas el permiso estuviera concedido si hoy nadie lo confirma.
    const estadoPermiso: GpsPermissionStateOrMissing =
      estado.permiso && !vencido ? estado.permiso.status : 'sin_reporte';

    const consintio = estado.consentimiento !== null;
    const comparte = ESTADOS_QUE_COMPARTEN.includes(estadoPermiso);
    // Quien acepto y comparte queda con recorrido registrado en los DOS modos:
    // aca no entra `gpsSharingMandatory`, que solo decide si se puede trabajar
    // sin compartir. El interruptor de registrar o no es `gpsTrackingEnabled`.
    const registra = reglas.gpsTrackingEnabled && consintio && comparte;

    let motivo: GpsBlockedReason | null = null;
    if (reglas.gpsTrackingEnabled && modo === 'obligatorio') {
      // El consentimiento va primero: es el paso legal y ademas es lo unico que
      // el guardia puede resolver dentro de la app.
      if (!consintio) motivo = 'sin_consentimiento';
      else if (estadoPermiso === 'sin_reporte') motivo = 'sin_reporte_de_permiso';
      else if (!comparte) motivo = 'permiso_denegado';
    }

    return {
      siteId,
      mode: modo,
      trackingEnabled: reglas.gpsTrackingEnabled,
      sampling: planDeMuestreo(reglas),
      retentionDays: reglas.gpsTrackRetentionDays,
      batteryBudgetPct: reglas.gpsBatteryBudgetPct,
      referenceHours: reglas.maxPatrolDurationMin / 60,
      consent: {
        granted: consintio,
        grantedAt: estado.consentimiento?.granted_at ?? null,
        policyVersion: estado.consentimiento?.policy_version ?? null,
      },
      permission: {
        status: estadoPermiso,
        reportedAt: reportadoEn,
        stale: vencido,
      },
      tracksLocation: registra,
      canStartPatrol: motivo === null,
      blockedReason: motivo,
      message: mensajeDe(motivo, reglas.gpsTrackingEnabled, registra),
    };
  }

  private async evaluarInicio(guardId: string, patrolId: string, bloquear: boolean) {
    const rondas = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string; status: string }>
    >(`SELECT id, site_id, status FROM patrols WHERE id = $1 AND guard_id = $2`, [
      patrolId,
      guardId,
    ]);
    const ronda = rondas[0];
    if (!ronda) throw new NotFoundException('La ronda asignada no existe');

    const politica = await this.policy(guardId, ronda.site_id);
    await this.registrarDecision(patrolId, politica);

    if (bloquear && !politica.canStartPatrol) {
      throw new ForbiddenException(politica.message);
    }

    return { patrolId, patrolStatus: ronda.status, ...politica };
  }

  /**
   * Deja la decision escrita en `patrol_gps_gate`.
   *
   * Gana la ultima: si el guardia queda bloqueado, activa el permiso y vuelve a
   * intentar, lo que tiene que quedar registrado es que arranco con ubicacion
   * compartida, no el intento fallido. El intento fallido no se pierde para el
   * negocio —la ronda no empezo— y guardar cada rebote convertiria la tabla en
   * un registro de conducta de la persona.
   */
  private async registrarDecision(patrolId: string, politica: GpsPolicy) {
    await this.tenantContext.manager.query(
      `INSERT INTO patrol_gps_gate (
         tenant_id, patrol_id, mode, permission_status,
         consent_granted, allowed, blocked_reason
       )
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, patrol_id) DO UPDATE SET
         mode = EXCLUDED.mode,
         permission_status = EXCLUDED.permission_status,
         consent_granted = EXCLUDED.consent_granted,
         allowed = EXCLUDED.allowed,
         blocked_reason = EXCLUDED.blocked_reason,
         decided_at = now()`,
      [
        patrolId,
        politica.mode,
        politica.permission.status,
        politica.consent.granted,
        politica.canStartPatrol,
        politica.blockedReason,
      ],
    );
  }
}

function modoDe(reglas: PatrolRules): GpsSharingMode {
  return reglas.gpsSharingMandatory ? 'obligatorio' : 'opcional';
}

function mensajeDe(
  motivo: GpsBlockedReason | null,
  seguimientoActivo: boolean,
  registra: boolean,
): string {
  if (motivo) return MENSAJES[motivo];
  if (!seguimientoActivo) return MENSAJES.seguimiento_apagado;
  return registra ? MENSAJES.registrando : MENSAJES.opcional_sin_gps;
}

/** Minutos entre dos instantes; 0 si falta alguno. */
function minutosEntre(desde: Date | null | undefined, hasta: Date | null | undefined): number {
  if (!desde || !hasta) return 0;
  return (new Date(hasta).getTime() - new Date(desde).getTime()) / 60_000;
}

/** El driver puede devolver numeric/smallint como texto segun el cast. */
function numeroONulo(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

/** Un decimal: aca se informan porcentajes y minutos, no precision de laboratorio. */
function redondear(valor: number): number {
  return Math.round(valor * 10) / 10;
}
