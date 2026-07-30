import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SyncPermissionCatalog1723474800000 implements MigrationInterface {
  name = 'SyncPermissionCatalog1723474800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('account:sessions:manage', 'Administrar las sesiones propias'),
        ('tenant:dashboard:read', 'Consultar el panel operacional autorizado'),
        ('tenant:security:manage', 'Configurar y revisar la seguridad de acceso')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO role_permissions (role_key, permission_key) VALUES
        ('SUPERADMIN', 'account:sessions:manage'),
        ('ADMIN', 'account:sessions:manage'),
        ('SUPERVISOR', 'account:sessions:manage'),
        ('GUARDIA', 'account:sessions:manage'),
        ('ADMIN', 'tenant:dashboard:read'),
        ('SUPERVISOR', 'tenant:dashboard:read'),
        ('ADMIN', 'tenant:security:manage')
      ON CONFLICT (role_key, permission_key) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM permissions
      WHERE key IN (
        'account:sessions:manage',
        'tenant:dashboard:read',
        'tenant:security:manage'
      )
    `);
  }
}
