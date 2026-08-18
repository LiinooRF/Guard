import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agregacion diaria de rondas + indices para las graficas de informes (#89).
 *
 * POR QUE UNA TABLA DE ROLLUP Y NO UNA VISTA MATERIALIZADA
 * -------------------------------------------------------
 * Una vista materializada NO se puede proteger con Row Level Security:
 * PostgreSQL no admite `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY`,
 * y el `REFRESH` corre con los privilegios del propietario leyendo las tablas
 * base. El objeto resultante contendria las filas de TODAS las empresas sin
 * ninguna politica que las separe: cualquier tenant que lo consultara veria al
 * resto. En un producto donde conviven empresas de seguridad privada eso no es
 * un bug, es una fuga. Una tabla normal si lleva `tenant_id`, `ENABLE` + `FORCE
 * ROW LEVEL SECURITY` y politica que falla cerrada, igual que el resto del
 * esquema.
 *
 * QUE SE GUARDA Y QUE NO
 * ----------------------
 * Se guardan SUMA y CONTEO de cumplimiento, nunca el promedio. Un promedio de
 * promedios esta mal en cuanto se agregan dias o recintos con distinta cantidad
 * de rondas; con suma/conteo el promedio ponderado se reconstruye correcto a
 * cualquier nivel.
 *
 * NO se guarda "rondas bajo umbral". El umbral es una regla configurable por
 * tenant (rules.ts, 70% es solo el default de un cliente): precalcularlo
 * congelaria en el historico el valor que regia el dia del calculo y el panel
 * mentiria despues de que el admin lo cambie. Esa cuenta se hace en vivo contra
 * `patrols`, que es donde el umbral vigente puede aplicarse.
 *
 * EL DIA ES EL DEL TURNO, NO EL DEL RELOJ DEL SERVIDOR
 * ---------------------------------------------------
 * `app_stats_service_day()` resuelve a que dia pertenece una ronda: al
 * `service_date` de su turno si lo tiene —la ronda de las 02:00 del turno
 * nocturno del viernes es del VIERNES, no del sabado— y si no, al dia
 * calendario en la zona horaria DEL RECINTO. Nunca la del servidor.
 *
 * Consecuencia: el filtro por instante tiene que ser mas ancho que el cubo. Se
 * usa una banda de -1/+2 dias y el dia real lo decide la funcion. Ademas, la
 * suma de un dia se aplica SIEMPRE al timestamp sin zona ANTES de convertir
 * (`(d::timestamp + INTERVAL '1 day') AT TIME ZONE tz`): al reves serian 24
 * horas fijas y en la noche del cambio de horario el corte del dia se correria
 * una hora.
 *
 * REFRESCO INCREMENTAL
 * --------------------
 * Triggers de SENTENCIA (no de fila) sobre `patrols` con tablas de transicion:
 * la generacion masiva de rondas de un turno recalcula los cubos afectados en
 * una sola pasada, no una por fila. Recalcular el cubo desde `patrols` —en vez
 * de sumar deltas— hace la operacion idempotente: un reintento, una
 * sincronizacion tardia del movil o un cierre de ronda que llega dias despues
 * dejan el cubo correcto, no descuadrado.
 *
 * El historico anterior a esta migracion NO se rellena aqui: una migracion
 * corre como propietario del esquema, y con FORCE ROW LEVEL SECURITY el
 * propietario tampoco ve las filas de ningun tenant. Rellenar exigiria una
 * conexion privilegiada, que es justo lo que este producto no usa. El relleno
 * ocurre en la primera lectura de cada empresa, dentro de su propia transaccion
 * con `app.tenant_id` puesto (ver StatsChartsService.asegurarCubos).
 */
export class CreatePatrolDailyStats1725289200000 implements MigrationInterface {
  name = 'CreatePatrolDailyStats1725289200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_stats_service_day(
        p_scheduled_start_at timestamptz,
        p_service_date date,
        p_timezone text
      ) RETURNS date
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$
        -- El turno es el contenedor: si la ronda cuelga de una asignacion de
        -- turno manda su service_date. Sin turno (ronda historica o suelta) se
        -- cae al dia calendario local DEL RECINTO.
        SELECT COALESCE(p_service_date, (p_scheduled_start_at AT TIME ZONE p_timezone)::date)
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE patrol_daily_stats (
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        -- Dia LOCAL del recinto (o service_date del turno). Nunca UTC.
        service_day date NOT NULL,
        patrols_total integer NOT NULL DEFAULT 0,
        patrols_completed integer NOT NULL DEFAULT 0,
        patrols_incomplete integer NOT NULL DEFAULT 0,
        patrols_expired integer NOT NULL DEFAULT 0,
        -- Pendientes y en curso: existen pero todavia no dicen nada del
        -- cumplimiento. Se cuentan aparte para no ensuciar el promedio.
        patrols_open integer NOT NULL DEFAULT 0,
        -- Suma y conteo, no promedio: ver el encabezado de la migracion.
        compliance_sum numeric(14,2) NOT NULL DEFAULT 0,
        compliance_count integer NOT NULL DEFAULT 0,
        checkpoints_expected bigint NOT NULL DEFAULT 0,
        computed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, site_id, service_day),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT patrol_daily_stats_totales_check CHECK (
          patrols_total >= 0
          AND compliance_count >= 0
          AND compliance_count <= patrols_total
          AND compliance_sum >= 0
        )
      )
    `);

    // La evolucion en el tiempo de TODO el tenant (o de una sucursal) recorre un
    // rango de dias sin fijar el recinto. La PK empieza por site_id, asi que no
    // sirve para eso: haria falta recorrerla entera. Este indice pone el dia
    // inmediatamente despues del tenant, que es el orden en que se lee la serie.
    await queryRunner.query(
      `CREATE INDEX patrol_daily_stats_dia_idx ON patrol_daily_stats (tenant_id, service_day)`,
    );

    await queryRunner.query(`ALTER TABLE patrol_daily_stats ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE patrol_daily_stats FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY patrol_daily_stats_isolation ON patrol_daily_stats
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    /**
     * Recalcula los cubos de UN recinto en un rango de dias, en una sola
     * sentencia. Es la unica definicion de la agregacion: la usan tanto el
     * trigger (rango de un dia) como el relleno de la lectura (rango de la
     * ventana pedida). Si estuviera escrita dos veces, tarde o temprano una de
     * las dos quedaria vieja y el panel mostraria dos verdades distintas.
     *
     * No es SECURITY DEFINER a proposito: corre con los privilegios de quien
     * escribe, asi que RLS sigue aplicando y no puede tocar cubos de otro
     * tenant aunque le pasen un uuid equivocado.
     */
    await queryRunner.query(`
      CREATE FUNCTION app_stats_recompute_range(
        p_tenant uuid,
        p_site uuid,
        p_desde date,
        p_hasta date
      ) RETURNS void
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_timezone text;
      BEGIN
        SELECT s.timezone INTO v_timezone
        FROM sites s
        WHERE s.tenant_id = p_tenant AND s.id = p_site;

        -- El recinto no existe o no es visible en este contexto RLS: no hay
        -- nada que agregar y no se toca el cubo de nadie mas.
        IF v_timezone IS NULL THEN
          RETURN;
        END IF;

        WITH dias AS (
          SELECT g.dia::date AS dia
          FROM generate_series(p_desde::timestamp, p_hasta::timestamp, INTERVAL '1 day') AS g(dia)
        ),
        rondas AS (
          SELECT
            app_stats_service_day(p.scheduled_start_at, a.service_date, v_timezone) AS dia,
            p.status,
            p.compliance_pct,
            jsonb_array_length(p.expected_checkpoint_ids) AS esperados
          FROM patrols p
          LEFT JOIN shift_assignments a
            ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
          WHERE p.tenant_id = p_tenant
            AND p.site_id = p_site
            -- Las rondas voluntarias (#133) son cobertura extra, no parte de lo
            -- programado: contarlas moveria el cumplimiento segun el animo del
            -- guardia.
            AND NOT p.is_voluntary
            -- Banda -1/+2 dias: una ronda cuyo service_date es del dia anterior
            -- puede empezar de madrugada del siguiente. El corte fino lo hace
            -- app_stats_service_day(); esto solo acota el indice.
            AND p.scheduled_start_at >= ((p_desde::timestamp - INTERVAL '1 day') AT TIME ZONE v_timezone)
            AND p.scheduled_start_at <  ((p_hasta::timestamp + INTERVAL '2 days') AT TIME ZONE v_timezone)
        )
        INSERT INTO patrol_daily_stats AS destino (
          tenant_id, site_id, service_day,
          patrols_total, patrols_completed, patrols_incomplete, patrols_expired,
          patrols_open, compliance_sum, compliance_count, checkpoints_expected,
          computed_at
        )
        SELECT
          p_tenant,
          p_site,
          d.dia,
          count(r.dia)::int,
          count(*) FILTER (WHERE r.status = 'completada')::int,
          count(*) FILTER (WHERE r.status = 'incompleta')::int,
          count(*) FILTER (WHERE r.status = 'vencida')::int,
          count(*) FILTER (WHERE r.status IN ('pendiente', 'en_curso'))::int,
          COALESCE(sum(r.compliance_pct), 0),
          count(*) FILTER (WHERE r.compliance_pct IS NOT NULL)::int,
          COALESCE(sum(r.esperados), 0),
          now()
        FROM dias d
        LEFT JOIN rondas r ON r.dia = d.dia
        GROUP BY d.dia
        ON CONFLICT (tenant_id, site_id, service_day) DO UPDATE SET
          patrols_total        = EXCLUDED.patrols_total,
          patrols_completed    = EXCLUDED.patrols_completed,
          patrols_incomplete   = EXCLUDED.patrols_incomplete,
          patrols_expired      = EXCLUDED.patrols_expired,
          patrols_open         = EXCLUDED.patrols_open,
          compliance_sum       = EXCLUDED.compliance_sum,
          compliance_count     = EXCLUDED.compliance_count,
          checkpoints_expected = EXCLUDED.checkpoints_expected,
          computed_at          = EXCLUDED.computed_at;
      END
      $$
    `);

    /**
     * Trigger de SENTENCIA con tablas de transicion. Junta los cubos afectados
     * (recinto + dia) y recalcula cada uno una sola vez, aunque la sentencia
     * haya tocado 200 rondas de una generacion de turno.
     *
     * En UPDATE se recalculan el cubo viejo Y el nuevo: mover una ronda de dia,
     * de recinto o marcarla voluntaria tiene que descontarla de donde estaba.
     */
    await queryRunner.query(`
      CREATE FUNCTION app_stats_patrols_sync() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM app_stats_recompute_range(c.tenant_id, c.site_id, c.dia, c.dia)
          FROM (
            SELECT DISTINCT
              n.tenant_id,
              n.site_id,
              app_stats_service_day(n.scheduled_start_at, a.service_date, s.timezone) AS dia
            FROM nuevas n
            JOIN sites s ON s.tenant_id = n.tenant_id AND s.id = n.site_id
            LEFT JOIN shift_assignments a
              ON a.tenant_id = n.tenant_id AND a.id = n.shift_assignment_id
          ) c;
        ELSIF TG_OP = 'DELETE' THEN
          PERFORM app_stats_recompute_range(c.tenant_id, c.site_id, c.dia, c.dia)
          FROM (
            SELECT DISTINCT
              v.tenant_id,
              v.site_id,
              app_stats_service_day(v.scheduled_start_at, a.service_date, s.timezone) AS dia
            FROM viejas v
            JOIN sites s ON s.tenant_id = v.tenant_id AND s.id = v.site_id
            LEFT JOIN shift_assignments a
              ON a.tenant_id = v.tenant_id AND a.id = v.shift_assignment_id
          ) c;
        ELSE
          PERFORM app_stats_recompute_range(c.tenant_id, c.site_id, c.dia, c.dia)
          FROM (
            SELECT DISTINCT
              n.tenant_id,
              n.site_id,
              app_stats_service_day(n.scheduled_start_at, a.service_date, s.timezone) AS dia
            FROM nuevas n
            JOIN sites s ON s.tenant_id = n.tenant_id AND s.id = n.site_id
            LEFT JOIN shift_assignments a
              ON a.tenant_id = n.tenant_id AND a.id = n.shift_assignment_id
            UNION
            SELECT DISTINCT
              v.tenant_id,
              v.site_id,
              app_stats_service_day(v.scheduled_start_at, a.service_date, s.timezone) AS dia
            FROM viejas v
            JOIN sites s ON s.tenant_id = v.tenant_id AND s.id = v.site_id
            LEFT JOIN shift_assignments a
              ON a.tenant_id = v.tenant_id AND a.id = v.shift_assignment_id
          ) c;
        END IF;

        RETURN NULL;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER patrols_stats_insert
      AFTER INSERT ON patrols
      REFERENCING NEW TABLE AS nuevas
      FOR EACH STATEMENT EXECUTE FUNCTION app_stats_patrols_sync()
    `);
    await queryRunner.query(`
      CREATE TRIGGER patrols_stats_update
      AFTER UPDATE ON patrols
      REFERENCING OLD TABLE AS viejas NEW TABLE AS nuevas
      FOR EACH STATEMENT EXECUTE FUNCTION app_stats_patrols_sync()
    `);
    await queryRunner.query(`
      CREATE TRIGGER patrols_stats_delete
      AFTER DELETE ON patrols
      REFERENCING OLD TABLE AS viejas
      FOR EACH STATEMENT EXECUTE FUNCTION app_stats_patrols_sync()
    `);

    // ---------------------------------------------------------------------
    // Indices. Cada uno dice a que consulta sirve; sin eso nadie sabe despues
    // si se puede borrar.
    // ---------------------------------------------------------------------

    /**
     * Sirve a: app_stats_recompute_range() —el recalculo de cubos, que es la
     * consulta mas repetida de todo esto— y a la grafica de puntos mas
     * omitidos, que acota `patrols` por recinto y periodo antes de tocar
     * `scans`.
     *
     * Orden de columnas: `tenant_id` y `site_id` entran por IGUALDAD y
     * `scheduled_start_at` por RANGO. Las de igualdad van primero; al reves el
     * motor tendria que recorrer todo el rango de fechas del tenant y descartar
     * recinto por recinto. El indice existente `patrols_schedule_idx
     * (tenant_id, scheduled_start_at, status)` tiene justamente ese problema
     * para estas consultas.
     *
     * Parcial por `NOT is_voluntary`: toda agregacion de cumplimiento excluye
     * las rondas voluntarias (#133), asi que el indice no carga filas que
     * ninguna de estas consultas va a leer.
     */
    await queryRunner.query(
      `CREATE INDEX patrols_stats_site_idx
       ON patrols (tenant_id, site_id, scheduled_start_at)
       WHERE NOT is_voluntary`,
    );

    /**
     * Sirve a: el ranking de guardias del tenant completo (y a cualquier
     * agregacion por periodo sin recinto fijo).
     *
     * Aca NO hay columna de igualdad util —se agrupa por guardia, no se filtra
     * por uno—, asi que la columna de rango va primero. Las columnas de
     * INCLUDE son las que consume la agregacion: con ellas el conteo y el
     * promedio salen del indice sin visitar la tabla, que es la diferencia
     * entre leer 300 mil punteros y leer 300 mil filas.
     */
    await queryRunner.query(
      `CREATE INDEX patrols_stats_periodo_idx
       ON patrols (tenant_id, scheduled_start_at)
       INCLUDE (site_id, guard_id, status, compliance_pct)
       WHERE NOT is_voluntary`,
    );

    /**
     * Sirve a: la grafica de puntos mas omitidos, que por cada punto esperado
     * de cada ronda pregunta `EXISTS (SELECT 1 FROM scans WHERE tenant_id = ..
     * AND patrol_id = .. AND checkpoint_id = ..)`.
     *
     * `scans` es la tabla mas grande del producto (una ronda son N escaneos).
     * El indice existente `scans_patrol_idx (tenant_id, patrol_id)` encuentra
     * los escaneos de la ronda pero obliga a ir a la tabla a leer
     * `checkpoint_id` fila por fila. Con `checkpoint_id` como tercera columna
     * el EXISTS se resuelve dentro del indice.
     *
     * Nota para quien mantenga esto: `scans_patrol_idx` queda redundante
     * (mismo prefijo). No se borra en esta migracion para no cambiar los planes
     * de otros modulos sin medirlo, pero es candidato a eliminarse.
     */
    await queryRunner.query(
      `CREATE INDEX scans_stats_punto_idx ON scans (tenant_id, patrol_id, checkpoint_id)`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON patrol_daily_stats TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER patrols_stats_delete ON patrols`);
    await queryRunner.query(`DROP TRIGGER patrols_stats_update ON patrols`);
    await queryRunner.query(`DROP TRIGGER patrols_stats_insert ON patrols`);
    await queryRunner.query(`DROP FUNCTION app_stats_patrols_sync()`);
    await queryRunner.query(`DROP INDEX scans_stats_punto_idx`);
    await queryRunner.query(`DROP INDEX patrols_stats_periodo_idx`);
    await queryRunner.query(`DROP INDEX patrols_stats_site_idx`);
    await queryRunner.query(`DROP FUNCTION app_stats_recompute_range(uuid, uuid, date, date)`);
    await queryRunner.query(`DROP TABLE patrol_daily_stats`);
    await queryRunner.query(`DROP FUNCTION app_stats_service_day(timestamptz, date, text)`);
  }
}
