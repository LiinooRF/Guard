import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra `checklists:manage` en el catalogo RBAC de la base (#265).
 *
 * El permiso ya existe en `packages/shared/src/permissions.ts` y es lo que el
 * guard de la API consulta en cada request (`hasPermission`), asi que la puerta
 * NO estaba abierta sin esto. Lo que faltaba es la otra copia del catalogo: las
 * tablas `permissions` y `role_permissions`, que es lo que el panel muestra y
 * lo que auditoria lee para responder "quien puede hacer que".
 *
 * Sin esta migracion, `permission-catalog.integration.spec.ts` —que compara el
 * catalogo del codigo con el de la base exigiendo igualdad EXACTA— se pone rojo
 * contra PostgreSQL real. Es un guardia que hace justo su trabajo: el catalogo
 * de permisos vive en dos lados y el dia que se separan, el panel dice una cosa
 * y el servidor hace otra.
 *
 * `ON CONFLICT DO NOTHING` en las dos tablas: la migracion tiene que poder
 * correr sobre una base que ya lo tenga (por un seed, o por reintentar un
 * despliegue) sin reventar.
 */
export class SembrarChecklistsManage1726174800000 implements MigrationInterface {
  name = 'SembrarChecklistsManage1726174800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('checklists:manage', 'Armar las tareas del turno: que revisar, donde, a que hora y si exige foto')
      ON CONFLICT (key) DO NOTHING
    `);
    // Solo el SUPERVISOR: decision de producto del 8-ago-2026 — las tareas las
    // arma quien conoce el terreno, acotado a sus recintos asignados.
    await queryRunner.query(`
      INSERT INTO role_permissions (role_key, permission_key) VALUES
        ('SUPERVISOR', 'checklists:manage')
      ON CONFLICT (role_key, permission_key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El orden importa: primero la asignacion, despues el permiso, o la clave
    // foranea de role_permissions lo impide.
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_key = 'checklists:manage'`,
    );
    await queryRunner.query(`DELETE FROM permissions WHERE key = 'checklists:manage'`);
  }
}
