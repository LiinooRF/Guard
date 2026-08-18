import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isPhotoRequired } from '@sentrycore/shared';

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
  /** Tiene fila propia en checkpoint_rules, o sea el ultimo nivel de la cascada. */
  tiene_reglas_propias: boolean;
}

interface PuntoEvaluado {
  name: string;
  tieneOverride: boolean;
  requiresPhoto: boolean;
  decideElPunto: boolean;
}

/**
 * Comprobacion del horario habil de un recinto en un instante dado (#68).
 *
 * Existe porque el criterio del issue —"una ronda de sabado en la madrugada
 * exige foto en cada punto"— hay que poder DEMOSTRARLO, y demostrarlo contra el
 * codigo que corre en terreno, no contra una copia de la regla escrita en el
 * navegador. Por eso este servicio no reimplementa nada: llama a
 * EvidenceService.isWithinBusinessHours() y a isPhotoRequired() de @sentrycore/shared,
 * que son exactamente los que decide el flujo de escaneo, y resuelve la cascada
 * de reglas con el MISMO contexto que EvidenceService.requiresPhoto(): recinto
 * para todos, y ademas el punto para los que tienen reglas propias.
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
     * CON contexto de recinto, que es la mitad de lo que pide en el escaneo
     * EvidenceService.requiresPhoto({ siteId, checkpointId }). La otra mitad,
     * el punto, se resuelve mas abajo punto por punto.
     *
     * Sin contexto la cascada se corta en plataforma+tenant: un tenant con
     * photoRequiredOnCritical en «si» y un recinto que lo apaga en site_rules
     * salia listado como «exige foto» mientras el guardia escaneaba sin que se
     * la pidieran. El panel prometia lo que la ronda ya no cumplia.
     */
    const rules = await this.rules.effective({ siteId });

    // En serie, no con Promise.all: el request corre dentro de UNA transaccion
    // con SET LOCAL app.tenant_id, y esa conexion atiende una consulta a la vez.
    const calendario = await this.leerCalendario(siteId, momento.local_date);
    const puntos = await this.leerPuntosActivos(siteId);

    const evaluados: PuntoEvaluado[] = [];
    for (const punto of puntos) {
      const ficha = { kind: punto.kind, requiresPhoto: punto.requires_photo };

      /*
       * Solo el punto que tiene fila en checkpoint_rules paga su consulta: sin
       * esa fila la cascada del punto devuelve exactamente lo mismo que la del
       * recinto, y un recinto de 40 puntos no puede costar 40 consultas para
       * llegar al mismo veredicto. En serie por lo mismo de arriba.
       */
      const propias = punto.tiene_reglas_propias
        ? await this.rules.effective({ siteId, checkpointId: punto.id })
        : null;

      const requiresPhoto = isPhotoRequired({
        checkpoint: ficha,
        withinBusinessHours,
        rules: propias ?? rules,
      });

      evaluados.push({
        name: punto.name,
        /**
         * El punto trae su propio «Foto: siempre/nunca» y ese valor gana sobre el
         * horario en las dos direcciones (isPhotoRequired lo resuelve primero).
         * null = no tiene override y lo decide el horario mas las reglas.
         */
        tieneOverride: punto.requires_photo !== null,
        requiresPhoto,
        /**
         * ¿El veredicto salio de las reglas DEL PUNTO? Se compara contra el
         * veredicto con las del recinto en vez de mirar si la fila existe: un
         * punto puede tener configurado el radio de GPS y nada que decir sobre
         * la foto, y ahi el motivo sigue siendo el de arriba.
         */
        decideElPunto:
          propias !== null &&
          requiresPhoto !== isPhotoRequired({ checkpoint: ficha, withinBusinessHours, rules }),
      });
    }

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
      /**
       * Las del RECINTO, ya con su override de site_rules aplicado: son las que
       * rigen para todo punto que no tenga las suyas. Un punto con fila en
       * checkpoint_rules puede apartarse de estas, y eso se lee en el motivo
       * 'reglas-punto' de la lista de exentos.
       */
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
         *  - 'reglas-punto': lo exime la configuracion de reglas DE ESE PUNTO
         *    (checkpoint_rules), no la del recinto. Depende del horario igual
         *    que las de arriba, pero se corrige en el punto y no en el recinto.
         *  - 'reglas': no la exige por como quedaron el horario y las reglas
         *    heredadas en ESTE instante (tipico: punto normal dentro de
         *    horario). Nadie le configuro nada al punto que cambie el veredicto,
         *    y en otro instante puede exigirla.
         *
         * Adivinar 'override' para todos era prometer una configuracion que no
         * existe; mandar todo a 'reglas' mandaba al admin a revisar el recinto
         * cuando lo que decidia era el punto.
         */
        exempt: evaluados
          .filter((punto) => !punto.requiresPhoto)
          .map((punto) => ({
            name: punto.name,
            motivo: punto.tieneOverride
              ? ('override' as const)
              : punto.decideElPunto
                ? ('reglas-punto' as const)
                : ('reglas' as const),
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

  /**
   * Los puntos activos y, de paso, cuales tienen reglas propias.
   *
   * El EXISTS no resuelve la cascada —eso sigue siendo trabajo de
   * RulesService— sino que dice a quien hay que preguntarle por ella: sin fila
   * en checkpoint_rules el veredicto del punto es el del recinto, palabra por
   * palabra, y preguntar de nuevo seria una consulta por punto para nada.
   */
  private leerPuntosActivos(siteId: string) {
    return this.tenantContext.manager.query<FilaPunto[]>(
      `SELECT c.id, c.name, c.kind, c.requires_photo,
              EXISTS (
                SELECT 1 FROM checkpoint_rules r
                 WHERE r.tenant_id = c.tenant_id AND r.checkpoint_id = c.id
              ) AS tiene_reglas_propias
         FROM checkpoints c
        WHERE c.site_id = $1 AND c.is_active = true
        ORDER BY c.suggested_order, c.name`,
      [siteId],
    );
  }
}
