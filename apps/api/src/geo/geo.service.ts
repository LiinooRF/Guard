import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import type { TrackPointDto } from './dto/append-track.dto';
import type { GrantConsentDto } from './dto/grant-consent.dto';
import { gpsRules } from './gps-rules';
import { haversineM } from './haversine';

/** Mismo criterio de desfase de reloj que el escaneo (#63). */
const TOLERANCIA_RELOJ_MS = 5 * 60_000;

const SIN_CONSENTIMIENTO =
  'No tienes consentimiento vigente de geolocalización: no se registra tu recorrido';

const TRAZA_DESACTIVADA =
  'Esta empresa no registra el recorrido de las rondas: no se guarda ubicación';

const FUERA_DE_RONDA =
  'Solo se registra recorrido mientras la ronda está en curso';

interface FilaPunto {
  recorded_at_device: Date;
  latitude: string;
  longitude: string;
  accuracy_m: string | null;
  battery_pct: number | null;
}

interface PuntoTraza {
  recordedAt: Date;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  batteryPct: number | null;
}

/**
 * Geolocalizacion: traza del recorrido (#134) y consentimiento del trabajador.
 *
 * El consentimiento NO es un formalismo administrativo puesto al lado de la
 * feature: es la condicion para que la feature funcione. appendTrack no guarda
 * un solo punto sin el, y revocarlo corta el registro inmediatamente.
 *
 * Este modulo no toca guard.service.ts: el escaneo sigue guardando su punto
 * suelto con su radio GPS, y la traza es una serie aparte.
 *
 * La POLITICA de ubicacion (obligatorio vs opcional, arranque de ronda, plan de
 * muestreo, bateria) vive en GpsPolicyService — issue #77.
 */
@Injectable()
export class GeoService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
  ) {}

  /**
   * Recibe el lote del muestreo en segundo plano.
   *
   * Tres filtros, en este orden y por este motivo:
   *   1. Seguimiento activo en el tenant (`gpsTrackingEnabled`): apagado, no se
   *      acumula recorrido de nadie.
   *
   *      OJO: no se mira `gpsSharingRequired`. Ese flag decide obligatorio vs
   *      OPCIONAL (#77), y opcional no es apagado: al que aceptó compartir
   *      ubicación se le registra el recorrido igual. Mirarlo aca era el bug que
   *      dejaba sin traza a las empresas que eligen no obligar.
   *   2. Consentimiento vigente del trabajador: sin el, 403. Es la regla legal.
   *   3. Ronda en curso: los puntos anteriores al inicio se DESCARTAN. Asi el
   *      "no se rastrea fuera del turno" es demostrable con la propia tabla, no
   *      una promesa del cliente movil.
   */
  async appendTrack(guardId: string, patrolId: string, puntos: readonly TrackPointDto[]) {
    const rules = await this.rules.effective();
    if (!rules.gpsTrackingEnabled) throw new ForbiddenException(TRAZA_DESACTIVADA);

    const consentimientos = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM gps_consents WHERE user_id = $1 AND revoked_at IS NULL`,
      [guardId],
    );
    if (!consentimientos.length) throw new ForbiddenException(SIN_CONSENTIMIENTO);

    const patrols = await this.tenantContext.manager.query<
      Array<{ id: string; status: string; started_at: Date | null; scheduled_start_at: Date }>
    >(
      `SELECT id, status, started_at, scheduled_start_at
       FROM patrols WHERE id = $1 AND guard_id = $2`,
      [patrolId, guardId],
    );
    const patrol = patrols[0];
    if (!patrol) throw new NotFoundException('La ronda asignada no existe');
    if (patrol.status !== 'en_curso') throw new ConflictException(FUERA_DE_RONDA);

    const inicio = new Date(patrol.started_at ?? patrol.scheduled_start_at).getTime();
    const limiteFuturo = Date.now() + TOLERANCIA_RELOJ_MS;

    // El ON CONFLICT resuelve el reenvio de un lote ya recibido; los repetidos
    // DENTRO del mismo lote se descartan aca para que la cuenta que se devuelve
    // al dispositivo sea exacta.
    const vistos = new Set<string>();
    const aceptados: TrackPointDto[] = [];
    let fueraDeTurno = 0;
    let duplicados = 0;
    for (const punto of puntos) {
      const instante = new Date(punto.recordedAt).getTime();
      if (Number.isNaN(instante) || instante < inicio || instante > limiteFuturo) {
        fueraDeTurno += 1;
        continue;
      }
      const clave = new Date(instante).toISOString();
      if (vistos.has(clave)) {
        duplicados += 1;
        continue;
      }
      vistos.add(clave);
      aceptados.push(punto);
    }

    let guardados = 0;
    if (aceptados.length) {
      const insertados = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `INSERT INTO patrol_tracks (
          tenant_id, patrol_id, guard_id, recorded_at_device,
          latitude, longitude, accuracy_m, battery_pct
        )
        SELECT app_tenant_id(), $1, $2, punto.recorded_at,
               punto.latitude, punto.longitude, punto.accuracy_m, punto.battery_pct
        FROM unnest($3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[], $7::smallint[])
          AS punto(recorded_at, latitude, longitude, accuracy_m, battery_pct)
        ON CONFLICT (tenant_id, patrol_id, recorded_at_device) DO NOTHING
        RETURNING id`,
        [
          patrolId,
          guardId,
          aceptados.map((p) => p.recordedAt),
          aceptados.map((p) => p.latitude),
          aceptados.map((p) => p.longitude),
          aceptados.map((p) => p.accuracyM ?? null),
          aceptados.map((p) => p.batteryPct ?? null),
        ],
      );
      guardados = insertados.length;
      duplicados += aceptados.length - guardados;
    }

    return {
      patrolId,
      received: puntos.length,
      stored: guardados,
      duplicates: duplicados,
      outsideShift: fueraDeTurno,
      sampleIntervalSeconds: rules.gpsTrackIntervalSeconds,
    };
  }

  /**
   * La traza ordenada, lista para dibujar sobre el mapa, con distancia total
   * por haversine y duracion.
   *
   * La distancia se calcula al leer y no se persiste: un lote que llega tarde
   * (offline de horas) cambiaria un total ya guardado y quedaria mintiendo.
   *
   * Los puntos con precision peor que `gpsTrackMaxAccuracyM` NO suman distancia
   * (#77). Se devuelven igual —son evidencia y explican los huecos— pero un fix
   * de 2 km de error en un subterraneo agregaria kilometros que nadie camino, y
   * ese total termina en el informe del cliente.
   */
  async patrolTrack(patrolId: string, requester: Pick<AuthenticatedUser, 'sub' | 'role'>) {
    const patrols = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string; guard_id: string; status: string }>
    >(`SELECT id, site_id, guard_id, status FROM patrols WHERE id = $1`, [patrolId]);
    const patrol = patrols[0];
    if (!patrol) throw new NotFoundException('La ronda no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados (ver roles.ts); el
    // permiso patrols:monitor no basta por si solo.
    if (requester.role === 'SUPERVISOR') {
      const asignado = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
        `SELECT true AS present FROM supervisor_sites
         WHERE site_id = $1 AND supervisor_id = $2`,
        [patrol.site_id, requester.sub],
      );
      if (!asignado.length) throw new ForbiddenException('No tienes este recinto asignado');
    }

    const filas = await this.tenantContext.manager.query<FilaPunto[]>(
      `SELECT recorded_at_device, latitude, longitude, accuracy_m, battery_pct
       FROM patrol_tracks
       WHERE patrol_id = $1
       ORDER BY recorded_at_device`,
      [patrolId],
    );

    // numeric llega como string desde el driver.
    const points: PuntoTraza[] = filas.map((fila) => ({
      recordedAt: fila.recorded_at_device,
      latitude: Number(fila.latitude),
      longitude: Number(fila.longitude),
      accuracyM: fila.accuracy_m === null ? null : Number(fila.accuracy_m),
      batteryPct: fila.battery_pct,
    }));

    const rules = await this.rules.effective({ siteId: patrol.site_id });
    const maximoError = gpsRules(rules).gpsTrackMaxAccuracyM;
    const confiable = (punto: PuntoTraza) =>
      punto.accuracyM === null || punto.accuracyM <= maximoError;

    // Se recorre la serie confiable en orden: dos puntos buenos separados por
    // uno malo siguen midiendo el tramo entre ellos.
    const paraDistancia = points.filter(confiable);
    let distancia = 0;
    for (let i = 1; i < paraDistancia.length; i += 1) {
      const previo = paraDistancia[i - 1]!;
      const actual = paraDistancia[i]!;
      distancia += haversineM(previo.latitude, previo.longitude, actual.latitude, actual.longitude);
    }

    const primero = points[0];
    const ultimo = points[points.length - 1];
    const duracionMs =
      primero && ultimo ? ultimo.recordedAt.getTime() - primero.recordedAt.getTime() : 0;

    return {
      patrolId,
      status: patrol.status,
      siteId: patrol.site_id,
      guardId: patrol.guard_id,
      pointCount: points.length,
      lowAccuracyPointCount: points.length - paraDistancia.length,
      maxAccuracyM: maximoError,
      totalDistanceM: redondear(distancia),
      durationMin: redondear(duracionMs / 60_000),
      firstPointAt: primero?.recordedAt ?? null,
      lastPointAt: ultimo?.recordedAt ?? null,
      retentionDays: rules.gpsTrackRetentionDays,
      points,
    };
  }

  /**
   * El trabajador acepta el texto informativo. Idempotente para la MISMA
   * version: reintentar no genera una fila nueva.
   *
   * Si la version del texto cambio, el consentimiento anterior se cierra y se
   * abre uno nuevo. Un consentimiento arrastrado a un texto que la persona no
   * leyo no acredita nada.
   */
  async grantConsent(userId: string, input: GrantConsentDto) {
    const vigentes = await this.tenantContext.manager.query<
      Array<{ id: string; granted_at: Date; policy_version: string }>
    >(
      `SELECT id, granted_at, policy_version
       FROM gps_consents WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    const vigente = vigentes[0];
    if (vigente && vigente.policy_version === input.policyVersion) {
      return {
        granted: true,
        grantedAt: vigente.granted_at,
        policyVersion: vigente.policy_version,
        replacedPreviousVersion: false,
      };
    }

    if (vigente) {
      await this.tenantContext.manager.query(
        `UPDATE gps_consents SET revoked_at = now() WHERE id = $1`,
        [vigente.id],
      );
    }

    const insertados = await this.tenantContext.manager.query<
      Array<{ id: string; granted_at: Date }>
    >(
      `INSERT INTO gps_consents (tenant_id, user_id, policy_version, device_info)
       VALUES (app_tenant_id(), $1, $2, $3)
       RETURNING id, granted_at`,
      [userId, input.policyVersion, input.deviceInfo ?? null],
    );
    const creado = insertados[0];
    if (!creado) throw new ConflictException('No se pudo registrar el consentimiento');

    return {
      granted: true,
      grantedAt: creado.granted_at,
      policyVersion: input.policyVersion,
      replacedPreviousVersion: Boolean(vigente),
    };
  }

  /**
   * Revocar es un derecho, no un tramite: responde OK aunque no hubiera nada
   * vigente, y nunca falla por estado.
   *
   * NO borra la traza ya registrada: son rondas que ya ocurrieron y su registro
   * respalda informes ya emitidos. Lo que corta es hacia adelante — desde aca,
   * appendTrack rechaza. Lo viejo caduca por gpsTrackRetentionDays.
   *
   * El UPDATE va envuelto en un CTE, igual que GuardService.startPatrol(): con
   * el driver de Postgres, `manager.query()` de un UPDATE devuelve
   * [filas, rowCount] y no el arreglo de filas. Leer `filas[0]` sobre eso
   * devolvia el ARREGLO de filas — truthy incluso vacio — y esta respuesta decia
   * `hadActiveConsent: true` con `revokedAt: undefined` aunque no hubiera nada
   * que revocar. Envuelto en `WITH ... SELECT` el command tag es SELECT y las
   * filas vienen planas.
   */
  async revokeConsent(userId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{ id: string; revoked_at: Date }>
    >(
      `WITH revocado AS (
         UPDATE gps_consents SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL
         RETURNING id, revoked_at
       )
       SELECT id, revoked_at FROM revocado`,
      [userId],
    );
    const revocado = filas[0];
    return {
      granted: false,
      revokedAt: revocado?.revoked_at ?? null,
      hadActiveConsent: Boolean(revocado),
    };
  }

  /**
   * Lo que la app consulta al abrir: si debe muestrear, cada cuanto y por
   * cuanto tiempo se conserva. La pantalla de consentimiento se arma con esto.
   *
   * `sharingMode` dice si la empresa EXIGE compartir ubicacion o lo deja
   * opcional (#77). La decision de dejar o no iniciar la ronda no se toma aca:
   * la resuelve GpsPolicyService, que ademas mira el permiso del sistema
   * operativo.
   */
  async consentStatus(userId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        id: string;
        granted_at: Date;
        revoked_at: Date | null;
        policy_version: string;
        device_info: string | null;
      }>
    >(
      `SELECT id, granted_at, revoked_at, policy_version, device_info
       FROM gps_consents
       WHERE user_id = $1
       ORDER BY granted_at DESC
       LIMIT 1`,
      [userId],
    );
    const ultimo = filas[0];
    const rules = await this.rules.effective();

    return {
      granted: Boolean(ultimo && ultimo.revoked_at === null),
      grantedAt: ultimo?.granted_at ?? null,
      revokedAt: ultimo?.revoked_at ?? null,
      policyVersion: ultimo?.policy_version ?? null,
      trackingEnabled: rules.gpsTrackingEnabled,
      sharingMode: rules.gpsSharingRequired ? 'obligatorio' : 'opcional',
      deviceInfo: ultimo?.device_info ?? null,
      sampleIntervalSeconds: rules.gpsTrackIntervalSeconds,
      retentionDays: rules.gpsTrackRetentionDays,
    };
  }
}

/** Un decimal: la traza tiene precision de metros, no de centimetros. */
function redondear(valor: number): number {
  return Math.round(valor * 10) / 10;
}
