import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reloj del dispositivo y escaneos atrasados. Ver issue #73.
 *
 * Dos problemas distintos que comparten causa: el telefono trabaja horas sin
 * señal y su hora no es confiable.
 *
 * 1. DESFASE DE RELOJ. Hasta ahora la unica pista era comparar la hora del
 *    telefono contra la del servidor EN EL MOMENTO DE RECIBIR, y eso confunde
 *    dos cosas que no tienen nada que ver: un telefono con la hora mal puesta y
 *    un telefono que estuvo 3 horas en un subterraneo. El segundo caso es
 *    normal y se estaba marcando como anomalia.
 *
 *    La medicion correcta necesita un tercer dato: la hora del telefono AL
 *    ENVIAR (no al escanear). Servidor menos ese valor es el desfase real del
 *    reloj, sin contaminarse con el tiempo que la operacion estuvo encolada.
 *    Eso es device_clock_readings.
 *
 *    El offset NO se guarda como columna: sale de restar las dos marcas de
 *    tiempo. Guardarlo seria una tercera copia del mismo dato, que es como se
 *    llega a una fila que se contradice a si misma.
 *
 * 2. ESCANEOS ATRASADOS. Si la ronda ya se cerro (por vencimiento o por el
 *    punto de cierre) y despues llega un escaneo, hoy se responde 409 y el
 *    escaneo se PIERDE: queda un renglon de rechazo en sync_operations y nada
 *    mas. late_scans lo conserva completo, con la hora real que se le pudo
 *    atribuir y con la clasificacion que decide si es una entrega tardia
 *    (el guardia escaneo a tiempo, la red llego tarde) o un escaneo hecho
 *    despues del cierre.
 *
 *    La regla de quien gana esta escrita en late-scan.policy.ts: gana la ronda
 *    cerrada. El cumplimiento ya informado NO se reescribe — un informe que se
 *    puede editar despues no sirve como prueba — pero el escaneo no se pierde y
 *    el supervisor lo revisa.
 *
 * scans.clock_offset_ms se llena SOLO cuando la medicion dice que ese telefono
 * estaba fuera de tolerancia. NULL significa "hora del dispositivo utilizable"
 * (medida y dentro de tolerancia, o sin medir). Asi el informe corrige la hora
 * exactamente en los escaneos que lo necesitan y no toca los demas.
 */
export class CreateClockSkewAndLateScans1725462020000 implements MigrationInterface {
  name = 'CreateClockSkewAndLateScans1725462020000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------ mediciones de reloj

    await queryRunner.query(`
      CREATE TABLE device_clock_readings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        -- Hora del telefono AL ENVIAR el lote. No es la hora del escaneo: si lo
        -- fuera, el tiempo encolado sin señal se sumaria al desfase y todo
        -- telefono que trabaja offline pareceria tener el reloj malo.
        device_reported_at timestamptz NOT NULL,
        server_received_at timestamptz NOT NULL DEFAULT now(),
        -- La tolerancia vigente al medir. Se guarda porque el admin la puede
        -- cambiar: sin esto, una medicion vieja no se puede volver a explicar.
        tolerance_ms integer NOT NULL
          CONSTRAINT device_clock_readings_tolerance_check CHECK (tolerance_ms > 0),
        operations integer NOT NULL DEFAULT 0
          CONSTRAINT device_clock_readings_operations_check CHECK (operations >= 0),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, guard_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
      )
    `);

    // Sostiene la ultima medicion de un guardia, que es la consulta de
    // GET /api/sync/clock y la que usa el panel para avisar "este telefono
    // viene con la hora corrida".
    await queryRunner.query(
      `CREATE INDEX device_clock_readings_guard_idx
       ON device_clock_readings (tenant_id, guard_id, server_received_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE device_clock_readings ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE device_clock_readings FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY device_clock_readings_isolation ON device_clock_readings
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    // ------------------------------------------------ escaneos atrasados

    await queryRunner.query(`
      CREATE TABLE late_scans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        -- La misma clave de idempotencia del dispositivo: reenviar la cola no
        -- deja dos anexos del mismo escaneo.
        client_scan_id uuid NOT NULL,
        -- El uid crudo de la etiqueta y no el checkpoint_id: resolver la
        -- etiqueta es trabajo del escaneo, y aca el escaneo justamente no se
        -- ejecuto. El punto se resuelve al mostrar, con LEFT JOIN a tags.
        tag_uid text NOT NULL
          CONSTRAINT late_scans_tag_uid_check CHECK (length(tag_uid) BETWEEN 4 AND 64),
        method text NOT NULL
          CONSTRAINT late_scans_method_check CHECK (method IN ('nfc', 'qr')),
        patrol_status text NOT NULL
          CONSTRAINT late_scans_patrol_status_check
          CHECK (patrol_status IN ('completada', 'incompleta', 'vencida')),
        classification text NOT NULL
          CONSTRAINT late_scans_classification_check
          CHECK (classification IN ('dentro_de_la_ventana', 'dentro_de_gracia', 'fuera_de_plazo')),
        minutes_late integer NOT NULL
          CONSTRAINT late_scans_minutes_late_check CHECK (minutes_late >= 0),
        -- El plazo de gracia vigente al clasificar, por lo mismo que tolerance_ms.
        grace_min integer NOT NULL
          CONSTRAINT late_scans_grace_min_check CHECK (grace_min >= 0),
        -- Hora cruda del telefono. Se conserva tal cual: es la evidencia.
        scanned_at_device timestamptz,
        -- Hora que se le atribuyo al escaneo despues de corregir el reloj. Es la
        -- que uso la clasificacion, y por eso queda escrita: una decision que no
        -- se puede reconstruir no se puede discutir.
        scanned_at_effective timestamptz NOT NULL,
        effective_source text NOT NULL
          CONSTRAINT late_scans_effective_source_check
          CHECK (effective_source IN ('dispositivo', 'corregido', 'servidor')),
        clock_offset_ms bigint,
        latitude numeric(9,6),
        longitude numeric(9,6),
        accuracy_m numeric(7,2),
        received_at_server timestamptz NOT NULL DEFAULT now(),
        reviewed_by uuid,
        reviewed_at timestamptz,
        review_decision text
          CONSTRAINT late_scans_review_decision_check
          CHECK (review_decision IN ('justificado', 'no_justificado')),
        review_note text
          CONSTRAINT late_scans_review_note_check
          CHECK (review_note IS NULL OR length(review_note) <= 500),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, patrol_id, client_scan_id),
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, guard_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        -- Con reviewed_by NULL el FK compuesto se satisface solo (MATCH SIMPLE),
        -- asi que sirve igual para el anexo todavia sin revisar.
        FOREIGN KEY (tenant_id, reviewed_by)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT late_scans_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT late_scans_longitude_check CHECK (longitude BETWEEN -180 AND 180),
        -- Una revision es quien, cuando y que decidio: las tres o ninguna. Media
        -- revision no le sirve a nadie que despues tenga que explicarla.
        CONSTRAINT late_scans_review_check CHECK (
          (reviewed_by IS NULL AND reviewed_at IS NULL AND review_decision IS NULL)
          OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_decision IS NOT NULL)
        ),
        CONSTRAINT late_scans_review_note_needs_review
          CHECK (review_note IS NULL OR reviewed_at IS NOT NULL)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX late_scans_patrol_idx ON late_scans (tenant_id, patrol_id)`,
    );
    // La bandeja del supervisor: lo que falta revisar, lo mas reciente arriba.
    await queryRunner.query(
      `CREATE INDEX late_scans_pendientes_idx
       ON late_scans (tenant_id, received_at_server DESC)
       WHERE reviewed_at IS NULL`,
    );

    await queryRunner.query(`ALTER TABLE late_scans ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE late_scans FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY late_scans_isolation ON late_scans
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    // ------------------------------------------------ correccion en el escaneo

    await queryRunner.query(`ALTER TABLE scans ADD COLUMN clock_offset_ms bigint`);

    // ------------------------------------------------ permisos

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          -- Una medicion no se edita ni se borra: o se hizo o no se hizo.
          GRANT SELECT, INSERT ON device_clock_readings TO voxia_app;
          REVOKE UPDATE, DELETE ON device_clock_readings FROM voxia_app;
          -- UPDATE es solo para dejar la revision del supervisor. Sin DELETE:
          -- borrar un escaneo atrasado es exactamente lo que haria quien quiere
          -- tapar una ronda que no se hizo.
          GRANT SELECT, INSERT, UPDATE ON late_scans TO voxia_app;
          REVOKE DELETE ON late_scans FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scans DROP COLUMN clock_offset_ms`);
    await queryRunner.query(`DROP TABLE late_scans`);
    await queryRunner.query(`DROP TABLE device_clock_readings`);
  }
}
