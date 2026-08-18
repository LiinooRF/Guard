import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Programacion automatica de rondas por turno. Issues #62 y #132.
 *
 * Hoy las rondas se asignan una por una a mano (supervisor.createPatrol). Con
 * dos recintos y tres turnos eso son decenas de altas diarias, y lo que se
 * olvida no queda cubierto: la programacion es lo que hace que "cada noche de
 * 22:00 a 06:00" ocurra sin que nadie se acuerde.
 *
 * shift_patterns responde el #132: CUANTAS rondas y de QUE ruta lleva cada
 * turno. El turno de noche puede correr otra ruta y otra frecuencia que el de
 * dia, y por eso la clave es (turno, ruta) y no el recinto: la frecuencia es
 * una propiedad del turno, no del lugar.
 *
 * schedule_runs es el registro de cada corrida del generador. Existe por dos
 * razones que no se pueden separar: auditoria ("¿por que hoy no se generaron
 * las rondas del turno de noche?") e idempotencia observable — dos corridas del
 * mismo dia dejan dos filas, la segunda con generated = 0, y eso es la prueba
 * de que reintentar no duplico nada.
 *
 * La idempotencia REAL no la sostiene schedule_runs sino el indice unico sobre
 * patrols: (tenant_id, shift_assignment_id, route_id, schedule_seq). Un "primero
 * consulto y despues inserto" en la aplicacion se rompe con dos corridas
 * simultaneas —dos replicas de la API, o un reintento del operador sobre un
 * request que aun no termina— y ahi el guardia recibe la ronda duplicada. El
 * indice cierra esa ventana en la base, que es donde se puede cerrar.
 *
 * schedule_seq es NULL en las rondas manuales y voluntarias: el indice es
 * parcial, asi que el supervisor puede seguir creando cuantas rondas quiera a
 * mano sobre el mismo turno sin chocar con lo generado.
 */
export class CreateShiftSchedules1724684400000 implements MigrationInterface {
  name = 'CreateShiftSchedules1724684400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE shift_patterns (
        tenant_id uuid NOT NULL,
        shift_id uuid NOT NULL,
        route_id uuid NOT NULL,
        -- Cuantas rondas se generan dentro de ese turno. Sin DEFAULT a
        -- proposito: cuantas rondas necesita un recinto es una decision del
        -- cliente, y un default en el DDL es una regla de negocio escondida en
        -- el esquema. Quien inserta la declara.
        patrols_per_shift smallint NOT NULL
          CONSTRAINT shift_patterns_count_check CHECK (patrols_per_shift BETWEEN 1 AND 48),
        -- Separacion minima entre rondas del mismo turno. Es una restriccion
        -- fisica: el guardia tiene que poder recorrer y volver. Si no caben las
        -- rondas pedidas con esta separacion, MANDA la separacion (ver
        -- scheduling.service.ts).
        min_gap_minutes integer NOT NULL
          CONSTRAINT shift_patterns_gap_check CHECK (min_gap_minutes BETWEEN 0 AND 1440),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, shift_id, route_id),
        FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
        -- RESTRICT y no CASCADE: borrar una ruta que un turno esta programando
        -- deja al recinto sin rondas de la noche a la mañana y sin aviso.
        FOREIGN KEY (tenant_id, route_id) REFERENCES routes(tenant_id, id) ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX shift_patterns_route_idx ON shift_patterns (tenant_id, route_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE schedule_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        -- NULL = la corrida abarco todos los recintos del tenant.
        site_id uuid,
        service_date date NOT NULL,
        generated integer NOT NULL DEFAULT 0
          CONSTRAINT schedule_runs_generated_check CHECK (generated >= 0),
        skipped integer NOT NULL DEFAULT 0
          CONSTRAINT schedule_runs_skipped_check CHECK (skipped >= 0),
        -- NULL = la disparo el job programado, no una persona.
        ran_by uuid,
        ran_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX schedule_runs_date_idx
       ON schedule_runs (tenant_id, service_date DESC, ran_at DESC)`,
    );

    // La ronda generada lleva su numero de orden DENTRO del turno (1..N). Junto
    // con (shift_assignment_id, route_id) identifica el hueco que ocupa, y es lo
    // que hace que generar dos veces sea una operacion sola.
    await queryRunner.query(`ALTER TABLE patrols ADD COLUMN schedule_seq smallint`);
    await queryRunner.query(`
      ALTER TABLE patrols ADD CONSTRAINT patrols_schedule_seq_check
      CHECK (schedule_seq IS NULL OR (schedule_seq > 0 AND shift_assignment_id IS NOT NULL))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX patrols_generated_slot_idx
      ON patrols (tenant_id, shift_assignment_id, route_id, schedule_seq)
      WHERE schedule_seq IS NOT NULL
    `);

    for (const tabla of ['shift_patterns', 'schedule_runs']) {
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON shift_patterns TO sentrycore_app;
          -- schedule_runs es bitacora, igual que audit_log: se acumula, no se
          -- corrige. Borrar la corrida que no genero nada es exactamente lo que
          -- haria quien quiere tapar una noche sin rondas.
          GRANT SELECT, INSERT ON schedule_runs TO sentrycore_app;
          REVOKE UPDATE, DELETE ON schedule_runs FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX patrols_generated_slot_idx`);
    await queryRunner.query(`ALTER TABLE patrols DROP CONSTRAINT patrols_schedule_seq_check`);
    await queryRunner.query(`ALTER TABLE patrols DROP COLUMN schedule_seq`);
    await queryRunner.query(`DROP TABLE schedule_runs`);
    await queryRunner.query(`DROP TABLE shift_patterns`);
  }
}
