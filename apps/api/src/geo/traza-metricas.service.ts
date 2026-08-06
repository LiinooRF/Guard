import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { analizarTraza, type FilaTrazaCruda } from './traza-analisis';
import { parametrosTraza } from './traza-rules';

/**
 * Traza del recorrido como dato de primera clase (#134).
 *
 * QUE AGREGA ESTE SERVICIO SOBRE LO QUE YA HABIA
 * ----------------------------------------------
 * `GeoService.patrolTrack` (#15) devuelve la serie de puntos para dibujarla y una
 * distancia total. `MapaRecorridoService` (#79) la pinta en el PDF.
 * `GpsPolicyService.patrolBattery` (#77) mide lo que cuesta en bateria. Ninguno
 * responde las preguntas de este issue: cuanto recorrio, donde nos quedamos sin
 * saber donde estaba, y cuanto tiempo estuvo detenido.
 *
 * Toda la aritmetica vive en `traza-analisis.ts`, que es puro. Aca solo se
 * resuelven permisos, reglas y filas. Esa separacion es a proposito: la
 * distancia de una ronda es un numero que termina discutido con el cliente, y
 * tiene que poder probarse caso por caso sin base de datos.
 *
 * NO SE PERSISTE NINGUN TOTAL
 * ---------------------------
 * Se calcula al leer, como ya hacia GeoService, y por el mismo motivo: un lote
 * que llega tarde —una ronda offline de horas que sincroniza al recuperar
 * señal— cambiaria un total ya guardado, y un numero guardado que dejo de ser
 * cierto es peor que ninguno. Si algun dia el volumen lo exige, el lugar es un
 * rollup recalculable como `patrol_daily_stats`, no un campo escrito una vez.
 *
 * ESTE SERVICIO NO ESCRIBE NADA. Todas sus consultas son SELECT, asi que el
 * driver devuelve el arreglo de filas plano; no hay ningun UPDATE cuyo
 * `[filas, rowCount]` haya que envolver en un CTE.
 */

/** Fila de patrols. Columnas verificadas contra 1722524400000-CreateDemoDomain. */
interface FilaRonda {
  id: string;
  site_id: string;
  guard_id: string;
  status: string;
  started_at: Date | null;
  closed_at: Date | null;
}

interface FilaDia {
  service_day: string;
  desde: string;
  hasta: string;
}

interface FilaRondaDelRecinto {
  id: string;
  service_day: string;
  started_at: Date | null;
  closed_at: Date | null;
}

interface FilaTrazaConRonda extends FilaTrazaCruda {
  patrol_id: string;
}

/**
 * Tope de rondas que se analizan en una serie diaria.
 *
 * No es una regla de negocio: es el techo de memoria de UNA respuesta. Cada
 * ronda son cientos de posiciones y el analisis corre en el proceso de la API,
 * no en Postgres. Cuando el periodo pedido trae mas, se analizan las mas
 * recientes y la respuesta lo dice (`truncated`), que es mejor que un numero
 * incompleto presentado como completo.
 */
export const MAX_RONDAS_SERIE = 100;

/**
 * Un dia de la serie.
 *
 * `analyzedPatrols` / `analyzedWithTrack` y no `patrols` / `withTrack`: bajo el
 * mismo prefijo `/api/geo` ya existe `GET /sites/:id/gps-coverage` (#77), que
 * agrega entero en SQL y sin tope y devuelve `patrols` y `withTrack` del mismo
 * recinto y la misma ventana. Estos son los de las rondas que ESTE endpoint
 * alcanzo a analizar (ver MAX_RONDAS_SERIE), y con el tope alcanzado no son el
 * mismo numero. Dos conteos distintos con el mismo nombre en la misma pantalla
 * es una llamada del cliente.
 */
export interface DiaTraza {
  serviceDay: string;
  analyzedPatrols: number;
  analyzedWithTrack: number;
  distanceM: number;
  measuredDistanceM: number;
  gapCount: number;
  gapMinutes: number;
  stopCount: number;
  stoppedMinutes: number;
  movingMinutes: number;
}

@Injectable()
export class TrazaMetricasService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly supervisor: SupervisorService,
  ) {}

  /**
   * Traza de una ronda, analizada: distancia, huecos de cobertura y tiempo
   * detenido.
   *
   * La ventana del analisis es la de la RONDA (`started_at` -> `closed_at`), no
   * la de los puntos: asi aparece el hueco de cabeza —la ronda arranco a las
   * 22:00 y la primera posicion llego a las 22:40—, que es justamente el que una
   * traza mirada sola no muestra. Con la ronda en curso no hay cierre y no se
   * inventa uno: la ventana termina en el ultimo punto.
   */
  async patrolTrackSummary(
    patrolId: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'>,
  ) {
    const rondas = await this.tenantContext.manager.query<FilaRonda[]>(
      `SELECT id, site_id, guard_id, status, started_at, closed_at
       FROM patrols
       WHERE id = $1`,
      [patrolId],
    );
    const ronda = rondas[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados: el permiso
    // reports:read no alcanza por si solo (ver roles.ts y CLAUDE.md). Se reusa
    // el control de SupervisorService en vez de repetir la consulta.
    if (requester.role === 'SUPERVISOR') {
      await this.supervisor.ensureAssignedSite(ronda.site_id, requester.sub);
    }

    // Reglas resueltas EN EL RECINTO de la ronda: el estacionamiento
    // subterraneo y la porteria de la entrada no se configuran igual.
    const reglas = await this.rules.effective({ siteId: ronda.site_id });
    const parametros = parametrosTraza(reglas);

    const filas = await this.tenantContext.manager.query<FilaTrazaCruda[]>(
      `SELECT recorded_at_device, latitude, longitude, accuracy_m, battery_pct
       FROM patrol_tracks
       WHERE patrol_id = $1
       ORDER BY recorded_at_device`,
      [patrolId],
    );

    const analisis = analizarTraza({
      filas,
      parametros,
      desde: ronda.started_at,
      hasta: ronda.closed_at,
    });

    return {
      patrolId,
      siteId: ronda.site_id,
      guardId: ronda.guard_id,
      status: ronda.status,
      startedAt: ronda.started_at,
      closedAt: ronda.closed_at,
      // Explica sin culpar a nadie una traza vacia: la empresa apago el registro.
      trackingEnabled: reglas.gpsTrackingEnabled,
      ...analisis,
    };
  }

  /**
   * Serie diaria del recinto: cuanto se recorrio, cuanto tiempo quedo sin
   * cobertura y cuanto se estuvo detenido, dia por dia.
   *
   * EL DIA ES EL DEL RECINTO, NO EL DEL SERVIDOR. Se reusa
   * `app_stats_service_day()` (migracion 1725289200000), que resuelve al
   * `service_date` del turno cuando la ronda cuelga de uno —la ronda de las
   * 02:00 del turno del viernes es del VIERNES— y si no, al dia calendario en la
   * zona del recinto. La suma de dias se aplica al timestamp SIN zona ANTES de
   * convertir: al reves serian 24 horas fijas y la noche del cambio de horario
   * correria el corte una hora.
   *
   * Las rondas VOLUNTARIAS (#133) si entran, al reves que en las agregaciones de
   * cumplimiento: alli se excluyen porque moverian el porcentaje segun el animo
   * del guardia, pero aca se mide distancia recorrida, y una vuelta extra es
   * distancia que se camino de verdad.
   */
  async siteTrackDaily(
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

    // Los dias salen como TEXTO a proposito. El driver convierte una columna
    // date a un Date de JavaScript a medianoche LOCAL DEL SERVIDOR, y al
    // serializarlo a ISO un servidor en otra zona devolveria el dia anterior:
    // todo el trabajo de resolver el dia del recinto se perderia en la ultima
    // linea.
    const filasDia = await this.tenantContext.manager.query<FilaDia[]>(
      `
        WITH rango AS (
          SELECT ((now() AT TIME ZONE $1::text)::date - ($2::int - 1)) AS desde,
                 (now() AT TIME ZONE $1::text)::date AS hasta
        )
        SELECT to_char(g.dia, 'YYYY-MM-DD') AS service_day,
               to_char(rango.desde::timestamp, 'YYYY-MM-DD') AS desde,
               to_char(rango.hasta::timestamp, 'YYYY-MM-DD') AS hasta
        FROM rango
        CROSS JOIN LATERAL generate_series(
          rango.desde::timestamp, rango.hasta::timestamp, INTERVAL '1 day'
        ) AS g(dia)
        ORDER BY g.dia
      `,
      [recinto.timezone, days],
    );

    const desde = filasDia[0]?.desde ?? null;
    const hasta = filasDia[filasDia.length - 1]?.hasta ?? null;
    const reglas = await this.rules.effective({ siteId });
    const parametros = parametrosTraza(reglas);

    const acumulado = new Map<string, DiaTraza>();
    for (const fila of filasDia) {
      acumulado.set(fila.service_day, diaVacio(fila.service_day));
    }

    // Sin dias no hay nada que consultar; ocurre solo si el rango viene vacio.
    const rondas =
      desde && hasta
        ? await this.tenantContext.manager.query<FilaRondaDelRecinto[]>(
            `
              SELECT q.id,
                     to_char(q.dia, 'YYYY-MM-DD') AS service_day,
                     q.started_at,
                     q.closed_at
              FROM (
                SELECT p.id,
                       app_stats_service_day(
                         p.scheduled_start_at, a.service_date, $2::text
                       ) AS dia,
                       p.scheduled_start_at,
                       p.started_at,
                       p.closed_at
                FROM patrols p
                LEFT JOIN shift_assignments a
                  ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
                WHERE p.site_id = $1::uuid
                  -- Banda -1/+2 dias: una ronda cuyo dia de servicio es el
                  -- anterior puede empezar de madrugada del siguiente. El corte
                  -- fino lo hace app_stats_service_day(); esto solo acota el
                  -- indice.
                  AND p.scheduled_start_at >=
                      (($3::date::timestamp - INTERVAL '1 day') AT TIME ZONE $2::text)
                  AND p.scheduled_start_at <
                      (($4::date::timestamp + INTERVAL '2 days') AT TIME ZONE $2::text)
              ) q
              -- El dia de servicio se acota ACA, antes del LIMIT: la banda de
              -- arriba llega hasta manana y el orden es descendente, asi que las
              -- rondas FUTURAS —que no entran en ningun cubo— se comian las
              -- primeras ranuras del tope y dejaban los dias mas viejos en cero.
              WHERE q.dia >= $3::date
                AND q.dia <= $4::date
              ORDER BY q.scheduled_start_at DESC
              LIMIT $5::int
            `,
            [siteId, recinto.timezone, desde, hasta, MAX_RONDAS_SERIE],
          )
        : [];

    // Red de seguridad del corte por dia de servicio, que ya hace el SQL: si
    // alguna vez la banda vuelve a ser mas ancha que los cubos, se descarta aca
    // en vez de escribir en un dia que no existe.
    const delPeriodo = rondas.filter((ronda) => acumulado.has(ronda.service_day));
    const puntosPorRonda = await this.puntosDe(delPeriodo.map((ronda) => ronda.id));

    let conTraza = 0;
    for (const ronda of delPeriodo) {
      const dia = acumulado.get(ronda.service_day)!;
      dia.analyzedPatrols += 1;

      const filas = puntosPorRonda.get(ronda.id) ?? [];
      if (filas.length > 0) {
        conTraza += 1;
        dia.analyzedWithTrack += 1;
      }

      // Las rondas SIN ninguna posicion se analizan igual, y a proposito: son el
      // caso maximo de "no sabemos donde estaba", y saltearlas hacia que un dia
      // con diez rondas mudas sumara MENOS minutos de hueco que uno con diez
      // rondas que reportaron un punto cada una. La metrica se veia mejor cuanto
      // peor era la cobertura. Con la ventana de la ronda, analizarTraza declara
      // el hueco completo; sin `started_at` (una ronda que nunca arranco) no hay
      // ventana que declarar y suma cero, que es lo honesto.
      const analisis = analizarTraza({
        filas,
        parametros,
        desde: ronda.started_at,
        hasta: ronda.closed_at,
      });
      acumular(dia, analisis);
    }

    const series = filasDia.map((fila) => redondearDia(acumulado.get(fila.service_day)!));

    return {
      siteId,
      siteName: recinto.name,
      timezone: recinto.timezone,
      days,
      from: desde,
      to: hasta,
      trackingEnabled: reglas.gpsTrackingEnabled,
      analyzedPatrols: delPeriodo.length,
      analyzedWithTrack: conTraza,
      /** true = el periodo tiene mas rondas de las que se analizaron. */
      truncated: rondas.length >= MAX_RONDAS_SERIE,
      maxPatrols: MAX_RONDAS_SERIE,
      thresholds: parametros,
      totals: totalesDe(series),
      series,
    };
  }

  /**
   * Puntos de varias rondas en una sola consulta.
   *
   * Se agrupan en memoria y no con un agregado en SQL porque el analisis es el
   * MISMO codigo puro que usa la ronda individual. Reescribir la distancia como
   * una consulta con `lag()` daria una segunda verdad sobre el mismo numero, que
   * es exactamente el problema que este issue viene a cerrar.
   */
  private async puntosDe(patrolIds: readonly string[]) {
    const porRonda = new Map<string, FilaTrazaCruda[]>();
    if (patrolIds.length === 0) return porRonda;

    const filas = await this.tenantContext.manager.query<FilaTrazaConRonda[]>(
      `SELECT patrol_id, recorded_at_device, latitude, longitude, accuracy_m, battery_pct
       FROM patrol_tracks
       WHERE patrol_id = ANY($1::uuid[])
       ORDER BY patrol_id, recorded_at_device`,
      [[...patrolIds]],
    );

    for (const fila of filas) {
      const acumulado = porRonda.get(fila.patrol_id);
      if (acumulado) acumulado.push(fila);
      else porRonda.set(fila.patrol_id, [fila]);
    }
    return porRonda;
  }
}

function diaVacio(serviceDay: string): DiaTraza {
  return {
    serviceDay,
    analyzedPatrols: 0,
    analyzedWithTrack: 0,
    distanceM: 0,
    measuredDistanceM: 0,
    gapCount: 0,
    gapMinutes: 0,
    stopCount: 0,
    stoppedMinutes: 0,
    movingMinutes: 0,
  };
}

/**
 * Lo que se puede sumar de un dia a otro. `AnalisisTraza` lo cumple sin
 * declararlo: son los mismos campos. Los promedios y porcentajes NO estan aca a
 * proposito — un promedio de promedios esta mal en cuanto los dias tienen
 * distinta cantidad de rondas, y es el mismo criterio de patrol_daily_stats.
 */
interface MetricasSumables {
  readonly distanceM: number;
  readonly measuredDistanceM: number;
  readonly gapCount: number;
  readonly gapMinutes: number;
  readonly stopCount: number;
  readonly stoppedMinutes: number;
  readonly movingMinutes: number;
}

function acumular(dia: DiaTraza, metricas: MetricasSumables): void {
  dia.distanceM += metricas.distanceM;
  dia.measuredDistanceM += metricas.measuredDistanceM;
  dia.gapCount += metricas.gapCount;
  dia.gapMinutes += metricas.gapMinutes;
  dia.stopCount += metricas.stopCount;
  dia.stoppedMinutes += metricas.stoppedMinutes;
  dia.movingMinutes += metricas.movingMinutes;
}

/** Los totales se suman crudos y se redondean UNA vez, al final. */
function redondearDia(dia: DiaTraza): DiaTraza {
  return {
    ...dia,
    distanceM: redondear(dia.distanceM),
    measuredDistanceM: redondear(dia.measuredDistanceM),
    gapMinutes: redondear(dia.gapMinutes),
    stoppedMinutes: redondear(dia.stoppedMinutes),
    movingMinutes: redondear(dia.movingMinutes),
  };
}

/**
 * Totales del periodo.
 *
 * Se suman los dias YA redondeados y no los analisis crudos: asi el total que
 * lee el cliente es exactamente la suma de la columna que ve en pantalla. Un
 * total que no cuadra con sus propias filas por dos decimos es una llamada del
 * cliente, no un detalle.
 */
function totalesDe(series: readonly DiaTraza[]) {
  const total = diaVacio('');
  for (const dia of series) {
    total.analyzedPatrols += dia.analyzedPatrols;
    total.analyzedWithTrack += dia.analyzedWithTrack;
    acumular(total, dia);
  }
  const redondeado = redondearDia(total);
  return {
    analyzedPatrols: redondeado.analyzedPatrols,
    analyzedWithTrack: redondeado.analyzedWithTrack,
    distanceM: redondeado.distanceM,
    measuredDistanceM: redondeado.measuredDistanceM,
    gapCount: redondeado.gapCount,
    gapMinutes: redondeado.gapMinutes,
    stopCount: redondeado.stopCount,
    stoppedMinutes: redondeado.stoppedMinutes,
    movingMinutes: redondeado.movingMinutes,
  };
}

function redondear(valor: number): number {
  return Math.round(valor * 10) / 10;
}
