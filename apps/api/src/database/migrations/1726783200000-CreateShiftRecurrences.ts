import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asignacion recurrente: "este guardia, este turno, estos dias".
 *
 * Hasta ahora asignar era por FECHA: `shift_assignments` guarda un guardia, un
 * turno y un `service_date` concreto. El panel disimulaba bien —el calendario
 * deja marcar varios dias y los manda uno por uno— pero cada semana habia que
 * rehacer el mismo trabajo a mano, y en un rubro con turnos fijos eso es
 * teclear lo mismo cincuenta veces al año por guardia.
 *
 * ESTO NO REEMPLAZA A `shift_assignments`
 * ---------------------------------------------------------------------------
 * La recurrencia es la REGLA; la asignacion sigue siendo el HECHO. Al generar
 * las rondas del dia, la regla se expande a asignaciones reales. Se hace asi y
 * no resolviendo la recurrencia al vuelo por dos motivos:
 *
 *   1. Una asignacion concreta se puede tocar: cambiar de guardia por una
 *      licencia, cancelarla por un feriado. Una regla no admite excepciones sin
 *      convertirse ella misma en una lista de excepciones.
 *   2. El historico tiene que quedar fijo. Si el turno de marzo se leyera desde
 *      la regla vigente hoy, cambiar la regla reescribiria el pasado.
 *
 * `weekdays` usa la misma convencion que `shifts.weekdays` y que
 * `EXTRACT(DOW)` de PostgreSQL: 0 = domingo. Inventar otra numeracion aca seria
 * garantizar un error de un dia en algun borde.
 */
export class CreateShiftRecurrences1726783200000 implements MigrationInterface {
  name = 'CreateShiftRecurrences1726783200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE shift_recurrences (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        shift_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        -- 0 = domingo, igual que shifts.weekdays y EXTRACT(DOW).
        weekdays smallint[] NOT NULL,
        starts_on date NOT NULL,
        -- NULL = sin fecha de termino. Es el caso normal de un turno fijo.
        ends_on date,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT shift_recurrences_weekdays_check
          CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7
                 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
        CONSTRAINT shift_recurrences_rango_check
          CHECK (ends_on IS NULL OR ends_on >= starts_on)
      )
    `);

    /*
     * Un guardia no puede tener DOS reglas activas para el mismo turno: se
     * pisarian y nadie sabria cual manda. Parcial sobre is_active para que dar
     * de baja una y crear otra siga siendo posible — que es como se corrige una
     * recurrencia mal cargada.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX shift_recurrences_una_activa
      ON shift_recurrences (tenant_id, shift_id, guard_id)
      WHERE is_active
    `);

    // La expansion pregunta "que reglas aplican a esta fecha": ese es el indice.
    await queryRunner.query(`
      CREATE INDEX shift_recurrences_vigentes_idx
      ON shift_recurrences (tenant_id, starts_on, ends_on) WHERE is_active
    `);

    await queryRunner.query(`ALTER TABLE shift_recurrences ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE shift_recurrences FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY shift_recurrences_isolation ON shift_recurrences
      FOR ALL
      USING (tenant_id = app_tenant_id())
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    /*
     * De donde salio la asignacion. Sirve para dos cosas concretas: que el panel
     * pueda decir "esto viene de la regla de los martes" en vez de un dato
     * suelto, y que al dar de baja una recurrencia se sepa cuales de sus
     * asignaciones futuras conviene retirar.
     *
     * ON DELETE SET NULL: borrar la regla no puede borrar el historico de
     * turnos que ya se trabajaron.
     */
    await queryRunner.query(`
      ALTER TABLE shift_assignments
        ADD COLUMN recurrence_id uuid REFERENCES shift_recurrences(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX shift_assignments_recurrence_idx
      ON shift_assignments (tenant_id, recurrence_id) WHERE recurrence_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS shift_assignments_recurrence_idx`);
    await queryRunner.query(`ALTER TABLE shift_assignments DROP COLUMN IF EXISTS recurrence_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS shift_recurrences`);
  }
}
