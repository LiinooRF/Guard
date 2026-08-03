import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Orden aleatorio anti-predictibilidad (#65).
 *
 * Una ronda siempre igual es predecible, y la predictibilidad es lo que un
 * intruso explota. El sorteo ocurre AL GENERAR la ronda, no al vuelo: el
 * snapshot `expected_checkpoint_ids` de la ronda ES el orden sorteado, asi el
 * informe puede mostrar exactamente el orden que correspondia.
 *
 * - `order_mode` en routes: 'fijo' (como siempre), 'aleatorio' (se baraja todo
 *   menos el cierre) o 'aleatorio_con_anclas' (las anclas conservan su posicion).
 * - `is_anchor` en route_checkpoints: puntos que no se mueven en el sorteo
 *   (ej: la porteria a mitad de recorrido por relevo de turno).
 *
 * Sin RLS nuevo: ambas tablas ya tienen ENABLE + FORCE y su politica de
 * aislamiento desde 1722524400000-CreateDemoDomain.
 */
export class AddRouteOrderMode1723993200000 implements MigrationInterface {
  name = 'AddRouteOrderMode1723993200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE routes
      ADD COLUMN order_mode text NOT NULL DEFAULT 'fijo'
        CONSTRAINT routes_order_mode_check
        CHECK (order_mode IN ('fijo', 'aleatorio', 'aleatorio_con_anclas'))
    `);
    await queryRunner.query(`
      ALTER TABLE route_checkpoints
      ADD COLUMN is_anchor boolean NOT NULL DEFAULT false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE route_checkpoints DROP COLUMN is_anchor`);
    await queryRunner.query(`ALTER TABLE routes DROP COLUMN order_mode`);
  }
}
