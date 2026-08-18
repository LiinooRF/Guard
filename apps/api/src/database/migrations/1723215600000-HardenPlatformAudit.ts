import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenPlatformAudit1723215600000 implements MigrationInterface {
  name = 'HardenPlatformAudit1723215600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          REVOKE INSERT, UPDATE, DELETE ON platform_audit_log FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE platform_audit_log NO FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT INSERT, UPDATE, DELETE ON platform_audit_log TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }
}
