import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Las tareas del turno: punto, hora y foto obligatoria (#265).
 *
 * El checklist ya existia (#129) como "lista de revision al cerrar la ronda".
 * Lo que pide el producto es una TAREA con lugar y hora — dicho por el usuario
 * el 8-ago-2026 con este ejemplo, que es el requisito literal:
 *
 *     "tengo asignada una tarea de ir A LAS 11, a CIERTO PUNTO, y tomar una
 *      IMAGEN al refrigerador"
 *
 * Tres columnas nuevas en `checklist_items`:
 *
 *   checkpoint_id   Donde se hace. NULL = tarea general del turno, que es como
 *                   se comportaba todo hasta ahora: se responde en el cierre.
 *                   Con punto, la tarea aparece al escanear ESE punto.
 *
 *   due_local_time  A que hora toca ("11:00"), en la zona DEL RECINTO. Es hora
 *                   sin fecha a proposito: una tarea se repite cada turno, y
 *                   guardar un timestamptz obligaria a generar filas por dia.
 *                   NULL = en cualquier momento de la ronda.
 *
 *   requires_photo  Foto SIEMPRE, este todo bien o mal. Es distinta de
 *                   `requires_photo_on_fail`, que ya existia: esa pide foto
 *                   solo al reportar una falla. "Fotografiar el refrigerador"
 *                   es evidencia del estado normal, no de una falla.
 *
 * Y en `checklist_responses`, la marca de que se respondio fuera de la hora
 * pedida. La regla del producto, textual: **"si la tarea queda fuera del
 * horario de la ronda, que se envie igual, pero que se mencione en el informe
 * y en todo en general"**. Es la misma politica que rige el resto del sistema
 * —marca y avisa, no rechaza— y por eso `late_minutes` es un dato, no un veto:
 * ninguna respuesta se pierde por llegar tarde.
 */
export class TareasDelTurno1726088400000 implements MigrationInterface {
  name = 'TareasDelTurno1726088400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE checklist_items
        ADD COLUMN checkpoint_id uuid,
        ADD COLUMN due_local_time time,
        ADD COLUMN requires_photo boolean NOT NULL DEFAULT false
    `);
    // La FK compuesta lleva tenant_id: sin el, una tarea de una empresa podria
    // apuntar al punto de otra y RLS no lo veria (la clave foranea no pasa por
    // las politicas). Es la misma forma que usan todas las tablas del dominio.
    await queryRunner.query(`
      ALTER TABLE checklist_items
        ADD CONSTRAINT checklist_items_checkpoint_fk
        FOREIGN KEY (tenant_id, checkpoint_id)
        REFERENCES checkpoints(tenant_id, id) ON DELETE SET NULL (checkpoint_id)
    `);
    // Lo que consulta el telefono al escanear un punto: sus tareas, en orden.
    await queryRunner.query(`
      CREATE INDEX checklist_items_checkpoint_idx
        ON checklist_items (tenant_id, checkpoint_id, position)
        WHERE checkpoint_id IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE checklist_responses
        ADD COLUMN late_minutes integer
          CONSTRAINT checklist_responses_late_check
          CHECK (late_minutes IS NULL OR late_minutes >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE checklist_responses DROP COLUMN late_minutes`);
    await queryRunner.query(`DROP INDEX IF EXISTS checklist_items_checkpoint_idx`);
    await queryRunner.query(
      `ALTER TABLE checklist_items DROP CONSTRAINT checklist_items_checkpoint_fk`,
    );
    await queryRunner.query(`
      ALTER TABLE checklist_items
        DROP COLUMN requires_photo,
        DROP COLUMN due_local_time,
        DROP COLUMN checkpoint_id
    `);
  }
}
