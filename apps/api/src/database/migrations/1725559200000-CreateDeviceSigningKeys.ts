import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Claves HMAC del shell nativo. El secreto se cifra en la API antes de persistir. */
export class CreateDeviceSigningKeys1725559200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE device_signing_keys (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        device_id uuid NOT NULL,
        encrypted_key bytea NOT NULL CHECK (octet_length(encrypted_key) = 60),
        registered_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        PRIMARY KEY (tenant_id, user_id, device_id),
        FOREIGN KEY (tenant_id, user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`ALTER TABLE device_signing_keys ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE device_signing_keys FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY device_signing_keys_tenant ON device_signing_keys
      USING (tenant_id = app_tenant_id())
      WITH CHECK (tenant_id = app_tenant_id())
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON device_signing_keys TO sentrycore_app;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`ALTER TABLE scans ADD COLUMN device_id uuid`);
    await queryRunner.query(`
      ALTER TABLE scans ADD COLUMN device_signature text
        CHECK (device_signature IS NULL OR device_signature ~ '^[0-9a-f]{64}$')
    `);
    await queryRunner.query(`ALTER TABLE scans ADD COLUMN guard_id uuid`);
    await queryRunner.query(`
      ALTER TABLE scans ADD CONSTRAINT scans_guard_membership_fk
        FOREIGN KEY (tenant_id, guard_id)
        REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      ALTER TABLE scans ADD CONSTRAINT scans_device_signature_pair_check
        CHECK ((device_id IS NULL) = (device_signature IS NULL))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scans DROP COLUMN guard_id`);
    await queryRunner.query(`ALTER TABLE scans DROP COLUMN device_signature`);
    await queryRunner.query(`ALTER TABLE scans DROP COLUMN device_id`);
    await queryRunner.query(`DROP TABLE device_signing_keys`);
  }
}
