import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra `checkpoints:manage` en el catalogo RBAC de la base (#309).
 *
 * El permiso ya existe en `packages/shared/src/permissions.ts` y es lo unico que
 * el guard de la API consulta en cada request (`hasPermission`): la puerta se
 * abre alla, no aca. Lo que falta es la otra copia del catalogo — las tablas
 * `permissions` y `role_permissions`—, que es lo que el panel muestra y lo que
 * auditoria lee para responder "quien puede hacer que".
 *
 * Sin esta migracion, `permission-catalog.integration.spec.ts` —que compara el
 * catalogo del codigo con el de la base exigiendo igualdad EXACTA— se pone rojo
 * contra PostgreSQL real. Ese guardia solo corre con `DATABASE_TEST_URL`, o sea
 * en CI: en la maquina de quien programa se salta, y por eso este archivo es
 * facil de olvidar y caro de olvidar.
 *
 * `ON CONFLICT DO NOTHING` en las dos tablas: tiene que poder correr sobre una
 * base que ya lo tenga (por un seed, o por reintentar un despliegue).
 */
export class SembrarCheckpointsManage1726351200000 implements MigrationInterface {
  name = 'SembrarCheckpointsManage1726351200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('checkpoints:manage', 'Administrar puntos de control y sus etiquetas en los recintos asignados')
      ON CONFLICT (key) DO NOTHING
    `);
    // Solo el SUPERVISOR. El ADMIN entra a los puntos por `tenant:sites:manage`,
    // que ademas le da los recintos enteros y no esta acotado por recinto.
    await queryRunner.query(`
      INSERT INTO role_permissions (role_key, permission_key) VALUES
        ('SUPERVISOR', 'checkpoints:manage')
      ON CONFLICT (role_key, permission_key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El orden importa: primero la asignacion, despues el permiso, o la clave
    // foranea de role_permissions lo impide.
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_key = 'checkpoints:manage'`,
    );
    await queryRunner.query(`DELETE FROM permissions WHERE key = 'checkpoints:manage'`);
  }
}
