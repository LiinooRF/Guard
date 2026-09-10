import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra `device:signing-key:enroll` en el catalogo RBAC de la base (#231).
 *
 * El permiso ya existe en `packages/shared/src/permissions.ts`, que es lo unico
 * que el guard de la API consulta en cada request. Lo que falta es la otra copia
 * del catalogo —`permissions` y `role_permissions`—, que es lo que el panel
 * muestra y lo que auditoria lee para responder "quien puede hacer que".
 *
 * Sin esto, `permission-catalog.integration.spec.ts` se pone rojo contra
 * PostgreSQL real: exige igualdad EXACTA entre las dos copias. Ese guardia solo
 * corre con `DATABASE_TEST_URL` —o sea en CI—, asi que en la maquina de quien
 * programa se salta y este archivo es facil de olvidar. Paso aca mismo.
 *
 * Va a los DOS roles que abren la app en un telefono. Registrar la clave de
 * firma es capacidad del EQUIPO, no de la tarea: estaba pegada a
 * `patrols:execute` y por eso el supervisor recibia 403 al abrir la pantalla de
 * puntos desde la app, quedandose sin lector NFC.
 */
export class SembrarDeviceSigningKeyEnroll1727474400000 implements MigrationInterface {
  name = 'SembrarDeviceSigningKeyEnroll1727474400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('device:signing-key:enroll', 'Registrar la clave de firma de este teléfono')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO role_permissions (role_key, permission_key) VALUES
        ('SUPERVISOR', 'device:signing-key:enroll'),
        ('GUARDIA', 'device:signing-key:enroll')
      ON CONFLICT (role_key, permission_key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Primero la asignacion y despues el permiso, o la clave foranea lo impide.
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_key = 'device:signing-key:enroll'`,
    );
    await queryRunner.query(`DELETE FROM permissions WHERE key = 'device:signing-key:enroll'`);
  }
}
