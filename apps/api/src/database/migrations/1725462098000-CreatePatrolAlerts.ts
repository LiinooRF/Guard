import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alertas de ronda para el supervisor (#98).
 *
 * QUE PROBLEMA RESUELVE
 * ---------------------
 * Hoy el supervisor se entera de que una ronda salio mal cuando mira el listado
 * de rondas, o cuando llega el informe al cierre. Las dos cosas llegan tarde: la
 * ronda que NO ARRANCO a las 22:00 hay que salvarla a las 22:15, no leerla al
 * dia siguiente. Esta tabla es la bandeja de esas condiciones, con su acuse.
 *
 * POR QUE UNA TABLA Y NO UNA CONSULTA EN VIVO
 * ------------------------------------------
 * La condicion se puede calcular en vivo (una ronda 'pendiente' con la hora
 * pasada es deducible), pero el ACUSE no: "quien atendio esta alerta y que
 * hizo" es un hecho que hay que guardar. Ademas, guardar la deteccion es lo que
 * permite avisar UNA sola vez: sin fila, cada refresco del tablero mandaria el
 * push de nuevo. La fila es la marca de "esto ya se aviso".
 *
 * POR QUE NO SE BORRA (sin DELETE para sentrycore_app)
 * ----------------------------------------------
 * Mismo criterio que event_notifications y schedule_runs: la alerta atendida es
 * la prueba de que alguien se hizo cargo, y la no atendida es la prueba de que
 * nadie lo hizo. Borrar la segunda es exactamente lo que haria quien quiere
 * tapar una noche mala. Se marca, no se borra.
 *
 * EL DIA ES EL DEL RECINTO
 * ------------------------
 * `service_day` se calcula con `app_stats_service_day()` (ver
 * 1725289200000-CreatePatrolDailyStats): service_date del turno si la ronda
 * cuelga de uno, y si no el dia calendario en la zona horaria DEL RECINTO. Un
 * tablero agrupado por el dia del servidor le mueve al supervisor la mitad del
 * turno de noche al dia siguiente.
 *
 * UNA ALERTA POR (RONDA, TIPO) Y UNA POR EVENTO
 * --------------------------------------------
 * Los indices unicos parciales son lo que hace idempotente al detector: puede
 * correr cada minuto, o dos veces a la vez, y no duplica filas ni avisos. El
 * chequeo previo en la aplicacion no alcanza — entre la consulta y el INSERT
 * cabe otra corrida.
 */
export class CreatePatrolAlerts1725462098000 implements MigrationInterface {
  name = 'CreatePatrolAlerts1725462098000';

  async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Comienzo de la ventana que revisa el detector: medianoche local del
     * recinto, p_dias hacia atras.
     *
     * La resta se aplica a la FECHA local y la conversion a zona ocurre
     * DESPUES. Restar `p_dias * interval '1 day'` a un timestamptz resta horas
     * fijas, y en la noche del cambio de horario eso corre el corte del dia una
     * hora: la ronda del borde entra o sale de la ventana segun el mes. Es la
     * misma regla que aplica app_stats_recompute_range.
     */
    await queryRunner.query(`
      CREATE FUNCTION app_alertas_desde(p_timezone text, p_dias integer)
      RETURNS timestamptz
      LANGUAGE sql STABLE
      AS $$
        SELECT ((timezone(p_timezone, now())::date - p_dias)::timestamp) AT TIME ZONE p_timezone
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE patrol_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        -- Exactamente uno de los dos: la alerta es de una ronda o de un evento
        -- en terreno. Lo garantiza patrol_alerts_target_check.
        patrol_id uuid,
        field_event_id uuid,
        kind text NOT NULL
          CONSTRAINT patrol_alerts_kind_check
          CHECK (kind IN (
            'no_iniciada',
            'atrasada',
            'vencida',
            'incompleta',
            'escaneos_sospechosos',
            'incidente_grave'
          )),
        -- Urgencia de la BANDEJA, no criticidad del evento. Decide si el aviso
        -- del telefono suena o espera a que el sistema junte trabajo.
        severity text NOT NULL DEFAULT 'media'
          CONSTRAINT patrol_alerts_severity_check CHECK (severity IN ('media', 'alta')),
        -- Instante en que la condicion se cumplio, no en que la vimos: la ronda
        -- que no arranco lleva la hora del vencimiento de su tolerancia, aunque
        -- el detector pase quince minutos despues.
        detected_at timestamptz NOT NULL DEFAULT now(),
        -- Dia LOCAL del recinto (o service_date del turno). Nunca UTC.
        service_day date NOT NULL,
        -- Contexto minimo para pintar la fila sin volver a la ronda. Numeros y
        -- referencias; nada de nombres ni ubicaciones de personas.
        detail jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT patrol_alerts_detail_check CHECK (jsonb_typeof(detail) = 'object'),
        -- Nulo mientras el aviso (push + tablero) no haya salido. Es lo que
        -- hace que se avise una sola vez y que un fallo se pueda reintentar.
        notified_at timestamptz,
        attended_at timestamptz,
        attended_by uuid,
        attended_comment text
          CONSTRAINT patrol_alerts_comment_check
          CHECK (
            attended_comment IS NULL
            OR length(trim(attended_comment)) BETWEEN 3 AND 500
          ),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        -- RESTRICT: field_events es append-only y no se borra; si algun dia se
        -- purgara, la alerta que lo referencia tiene que impedirlo a gritos.
        FOREIGN KEY (tenant_id, field_event_id)
          REFERENCES field_events(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, attended_by)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT patrol_alerts_target_check
          CHECK (num_nonnulls(patrol_id, field_event_id) = 1),
        -- Atendida sin quien la atendio es un registro que no sirve de nada en
        -- la conversacion del dia siguiente.
        CONSTRAINT patrol_alerts_attended_check
          CHECK ((attended_at IS NULL) = (attended_by IS NULL)),
        CONSTRAINT patrol_alerts_comment_needs_ack_check
          CHECK (attended_comment IS NULL OR attended_at IS NOT NULL)
      )
    `);

    // Idempotencia del detector: una alerta por (ronda, tipo). La misma ronda si
    // puede acumular 'atrasada' y despues 'incompleta' — son hechos distintos.
    await queryRunner.query(`
      CREATE UNIQUE INDEX patrol_alerts_ronda_idx
      ON patrol_alerts (tenant_id, patrol_id, kind)
      WHERE patrol_id IS NOT NULL
    `);
    // Un evento grave genera una alerta y no una por corrida del detector.
    await queryRunner.query(`
      CREATE UNIQUE INDEX patrol_alerts_evento_idx
      ON patrol_alerts (tenant_id, field_event_id)
      WHERE field_event_id IS NOT NULL
    `);

    /**
     * Sirve a: el tablero del supervisor, que pide las alertas de UN recinto
     * ordenadas por antiguedad de deteccion. tenant_id y site_id entran por
     * igualdad y detected_at por orden, en ese orden de columnas.
     */
    await queryRunner.query(`
      CREATE INDEX patrol_alerts_tablero_idx
      ON patrol_alerts (tenant_id, site_id, detected_at DESC)
    `);
    /**
     * Sirve a: el contador de pendientes (el numerito rojo del tablero) y a la
     * barrida de avisos sin mandar. Parcial porque las dos consultas descartan
     * lo ya atendido, que es la mayoria de las filas historicas.
     */
    await queryRunner.query(`
      CREATE INDEX patrol_alerts_pendientes_idx
      ON patrol_alerts (tenant_id, site_id, detected_at)
      WHERE attended_at IS NULL
    `);

    await queryRunner.query(`ALTER TABLE patrol_alerts ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE patrol_alerts FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY patrol_alerts_isolation ON patrol_alerts
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- UPDATE si: marcar atendida y marcar avisada son actualizaciones.
          GRANT SELECT, INSERT, UPDATE ON patrol_alerts TO sentrycore_app;
          -- Sin DELETE: la alerta sin atender es la prueba de que nadie la
          -- atendio. Borrarla es la version silenciosa de no haber avisado.
          REVOKE DELETE ON patrol_alerts FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE patrol_alerts`);
    await queryRunner.query(`DROP FUNCTION app_alertas_desde(text, integer)`);
  }
}
