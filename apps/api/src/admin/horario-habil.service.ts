import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isPhotoRequired } from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { EvidenceService } from '../evidence/evidence.service';
import { RulesService } from '../rules/rules.service';

interface FilaMomento {
  timezone: string;
  local_date: string;
  local_time: string;
  weekday: number;
  momento: Date | string;
}

interface FilaPunto {
  id: string;
  name: string;
  kind: 'normal' | 'acceso_critico';
  requires_photo: boolean | null;
}

/**
 * Comprobacion del horario habil de un recinto en un instante dado (#68).
 *
 * Existe porque el criterio del issue —"una ronda de sabado en la madrugada
 * exige foto en cada punto"— hay que poder DEMOSTRARLO, y demostrarlo contra el
 * codigo que corre en terreno, no contra una copia de la regla escrita en el
 * navegador. Por eso este servicio no reimplementa nada: llama a
 * EvidenceService.isWithinBusinessHours() y a isPhotoRequired() de @voxia/shared,
 * que son exactamente los que decide el flujo de escaneo.
 *
 * Es de solo lectura: no escribe ni una fila.
 */
@Injectable()
export class HorarioHabilService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly evidence: EvidenceService,
    private readonly rules: RulesService,
  ) {}

  async comprobar(siteId: string, date?: string, time?: string) {
    if ((date === undefined) !== (time === undefined)) {
      throw new BadRequestException(
        'Manda fecha y hora juntas, o ninguna de las dos para comprobar el momento actual',
      );
    }

    const momento = await this.resolverMomento(siteId, date ?? null, time ?? null);
    const instante = new Date(momento.momento);

    // La verdad de terreno, sin copia intermedia.
    const withinBusinessHours = await this.evidence.isWithinBusinessHours(siteId, instante);

    /*
     * Sin contexto de recinto ni de punto, A PROPOSITO: es lo mismo que hace
     * EvidenceService.requiresPhoto(), que es quien decide en el escaneo. Si el
     * panel resolviera la cascada mas fina que el terreno, mostraria una
     * promesa que la ronda no cumple. Ver la nota de INTEGRACION.md: eso hoy
     * ignora los overrides por recinto y por punto, y cuando se corrija allá,
     * esta llamada tiene que cambiar en el mismo commit.
     */
    const rules = await this.rules.effective();

    // En serie, no con Promise.all: el request corre dentro de UNA transaccion
    // con SET LOCAL app.tenant_id, y esa conexion atiende una consulta a la vez.
    const calendario = await this.leerCalendario(siteId, momento.local_date);
    const puntos = await this.leerPuntosActivos(siteId);

    const evaluados = puntos.map((punto) => ({
      name: punto.name,
      /**
       * El punto trae su propio «Foto: siempre/nunca» y ese valor gana sobre el
       * horario en las dos direcciones (isPhotoRequired lo resuelve primero).
       * null = no tiene override y lo decide el horario mas las reglas.
       */
      tieneOverride: punto.requires_photo !== null,
      requiresPhoto: isPhotoRequired({
        checkpoint: { kind: punto.kind, requiresPhoto: punto.requires_photo },
        withinBusinessHours,
        rules,
      }),
    }));

    return {
      timezone: momento.timezone,
      localDate: momento.local_date,
      localTime: momento.local_time,
      weekday: Number(momento.weekday),
      /** El instante real que se evaluo, ya convertido por Postgres. */
      instant: instante.toISOString(),
      withinBusinessHours,
      /**
       * false = el recinto no tiene ni horario ni feriado ese dia, asi que el
       * veredicto de arriba lo decidio la regla businessHoursDefaultOpen y no
       * una configuracion del recinto.
       */
      hasSchedule: calendario.tramos > 0 || calendario.feriado !== null,
      weekdaySegments: calendario.tramosDelDia,
      holiday: calendario.feriado,
      rules: {
        photoRequiredOutsideHours: rules.photoRequiredOutsideHours,
        photoRequiredOnCritical: rules.photoRequiredOnCritical,
        businessHoursDefaultOpen: rules.businessHoursDefaultOpen,
      },
      checkpoints: {
        total: evaluados.length,
        requirePhoto: evaluados.filter((punto) => punto.requiresPhoto).length,
        /**
         * Puntos que NO exigen foto en este instante, cada uno con su motivo —
         * que no es el mismo y la diferencia le importa al admin:
         *
         *  - 'override': el punto tiene «Foto: nunca» propio. Queda exento a
         *    cualquier hora y cambiar el horario no lo toca.
         *  - 'reglas': no la exige por como quedaron el horario y las reglas en
         *    ESTE instante (tipico: punto normal dentro de horario). Nadie le
         *    configuro nada al punto, y en otro instante puede exigirla.
         *
         * Adivinar 'override' para todos era prometer una configuracion que no
         * existe.
         */
        exempt: evaluados
          .filter((punto) => !punto.requiresPhoto)
          .map((punto) => ({
            name: punto.name,
            motivo: punto.tieneOverride ? ('override' as const) : ('reglas' as const),
          })),
      },
    };
  }

  /**
   * Fecha y hora locales del recinto -> instante.
   *
   * `$2::date + $3::time` arma un timestamp SIN zona: primero se suma el dia,
   * y recien despues `AT TIME ZONE s.timezone` lo convierte a instante. Al reves
   * (mover un instante y convertir despues) se corre una hora en cada cambio de
   * horario de verano. Sin parametros, `now() AT TIME ZONE s.timezone` da la
   * hora local del recinto ahora mismo.
   */
  private async resolverMomento(
    siteId: string,
    date: string | null,
    time: string | null,
  ): Promise<FilaMomento> {
    const filas = await this.tenantContext.manager.query<FilaMomento[]>(
      `
        WITH recinto AS (
          SELECT s.timezone AS timezone,
                 COALESCE(
                   $2::date + $3::time,
                   date_trunc('minute', now() AT TIME ZONE s.timezone)
                 ) AS local_ts
          FROM sites s
          WHERE s.id = $1
        )
        SELECT r.timezone,
               to_char(r.local_ts, 'YYYY-MM-DD') AS local_date,
               to_char(r.local_ts, 'HH24:MI') AS local_time,
               EXTRACT(DOW FROM r.local_ts)::int AS weekday,
               (r.local_ts AT TIME ZONE r.timezone) AS momento
        FROM recinto r
      `,
      [siteId, date, time],
    );

    const fila = filas[0];
    if (!fila) throw new NotFoundException('El recinto no existe');
    return fila;
  }

  /** Feriado de esa fecha local y tramos cargados, para explicar el veredicto. */
  private async leerCalendario(siteId: string, localDate: string) {
    const feriados = await this.tenantContext.manager.query<Array<{ name: string | null }>>(
      `SELECT name FROM site_holidays WHERE site_id = $1 AND holiday_date = $2::date`,
      [siteId, localDate],
    );

    const totales = await this.tenantContext.manager.query<Array<{ tramos: number }>>(
      `SELECT count(*)::int AS tramos FROM site_business_hours WHERE site_id = $1`,
      [siteId],
    );

    const delDia = await this.tenantContext.manager.query<
      Array<{ weekday: number; opens_at: string; closes_at: string }>
    >(
      `SELECT weekday,
              to_char(opens_at, 'HH24:MI') AS opens_at,
              to_char(closes_at, 'HH24:MI') AS closes_at
         FROM site_business_hours
        WHERE site_id = $1
          AND weekday IN (
            EXTRACT(DOW FROM $2::date)::int,
            (EXTRACT(DOW FROM $2::date)::int + 6) % 7
          )
        ORDER BY weekday`,
      [siteId, localDate],
    );

    const feriado = feriados[0];
    return {
      // count() llega como string desde el driver aunque el SQL castee.
      tramos: Number(totales[0]?.tramos ?? 0),
      feriado: feriado ? { date: localDate, name: feriado.name } : null,
      /**
       * El tramo del dia y el del dia ANTERIOR: el segundo es el que puede
       * derramar su madrugada sobre este dia (opens_at > closes_at).
       */
      tramosDelDia: delDia.map((fila) => ({
        weekday: fila.weekday,
        opensAt: fila.opens_at,
        closesAt: fila.closes_at,
      })),
    };
  }

  private leerPuntosActivos(siteId: string) {
    return this.tenantContext.manager.query<FilaPunto[]>(
      `SELECT id, name, kind, requires_photo
         FROM checkpoints
        WHERE site_id = $1 AND is_active = true
        ORDER BY suggested_order, name`,
      [siteId],
    );
  }
}
