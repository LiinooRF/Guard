import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Turnos y marcaje de jornada. Ver issues #130, #131 y #133.
 *
 * El turno es el contenedor de lo que pasa en una jornada: rondas, novedades y
 * panicos cuelgan de el. Sin esta entidad no se puede responder "quien esta de
 * servicio ahora en este recinto", que es de donde sale el escalamiento.
 *
 * ALCANCE DEL MARCAJE: es operativo ("¿esta el guardia en su puesto?"), NO el
 * registro electronico de asistencia que regula la Direccion del Trabajo. Ese
 * tiene requisitos propios que esto no cubre y no debe venderse como reemplazo.
 */
export class CreateShifts1724252400000 implements MigrationInterface {
  name = 'CreateShifts1724252400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE shifts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        name text NOT NULL,
        starts_at time NOT NULL,
        ends_at time NOT NULL,
        -- Dias de la semana en que aplica: 0=domingo .. 6=sabado.
        weekdays smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
        entry_tolerance_min integer NOT NULL DEFAULT 15
          CONSTRAINT shifts_tolerance_check CHECK (entry_tolerance_min >= 0),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        -- starts_at > ends_at es un turno NOCTURNO que cruza medianoche: valido.
        CONSTRAINT shifts_window_check CHECK (starts_at <> ends_at),
        CONSTRAINT shifts_weekdays_check CHECK (
          array_length(weekdays, 1) BETWEEN 1 AND 7
          AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX shifts_site_idx ON shifts (tenant_id, site_id)`);

    await queryRunner.query(`
      CREATE TABLE shift_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        shift_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        service_date date NOT NULL,
        status text NOT NULL DEFAULT 'asignado'
          CONSTRAINT shift_assignments_status_check
          CHECK (status IN ('asignado', 'en_curso', 'cerrado', 'ausente')),
        started_at timestamptz,
        ended_at timestamptz,
        start_latitude numeric(9,6),
        start_longitude numeric(9,6),
        end_latitude numeric(9,6),
        end_longitude numeric(9,6),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        -- Un guardia no puede estar dos veces en el mismo turno el mismo dia.
        UNIQUE (tenant_id, shift_id, guard_id, service_date),
        FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT shift_assignments_end_check CHECK (ended_at IS NULL OR started_at IS NOT NULL),
        CONSTRAINT shift_assignments_order_check CHECK (ended_at IS NULL OR ended_at >= started_at)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX shift_assignments_guard_idx
       ON shift_assignments (tenant_id, guard_id, service_date DESC)`,
    );
    // "Quien esta de turno ahora": el indice que sostiene esa pregunta.
    await queryRunner.query(
      `CREATE INDEX shift_assignments_active_idx
       ON shift_assignments (tenant_id, shift_id, status) WHERE status = 'en_curso'`,
    );

    // La ronda pertenece a un turno (nullable: las voluntarias y el historico
    // previo a esta migracion no tienen uno).
    await queryRunner.query(
      `ALTER TABLE patrols ADD COLUMN shift_assignment_id uuid
       REFERENCES shift_assignments(id) ON DELETE SET NULL`,
    );
    // Ronda voluntaria (#133): se registra igual pero NO cuenta contra el
    // cumplimiento programado; suma como cobertura extra.
    await queryRunner.query(
      `ALTER TABLE patrols ADD COLUMN is_voluntary boolean NOT NULL DEFAULT false`,
    );

    for (const tabla of ['shifts', 'shift_assignments']) {
      await queryRunner.query(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${tabla}_isolation ON ${tabla}
        FOR ALL
        USING (
          tenant_id = app_tenant_id()
          OR app_has_audited_support_access(tenant_id)
        )
        WITH CHECK (tenant_id = app_tenant_id())
      `);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON shifts, shift_assignments TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE patrols DROP COLUMN is_voluntary`);
    await queryRunner.query(`ALTER TABLE patrols DROP COLUMN shift_assignment_id`);
    await queryRunner.query(`DROP TABLE shift_assignments`);
    await queryRunner.query(`DROP TABLE shifts`);
  }
}
