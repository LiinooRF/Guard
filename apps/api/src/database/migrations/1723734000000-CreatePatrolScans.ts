import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Escaneos de una ronda. Ver issue #63 (ejecucion) y #14 (offline).
 *
 * Diseño para el mundo sin señal:
 * - `client_scan_id` lo genera EL DISPOSITIVO. El reenvio tras recuperar red es
 *   idempotente: (tenant, patrol, client_scan_id) unico y el conflicto se
 *   responde con el escaneo original, nunca con una fila duplicada.
 * - `scanned_at_device` es la hora del telefono; `scanned_at_server` la nuestra.
 *   Se guardan ambas porque la diferencia ES una señal (reloj_desfasado).
 * - `anomalies` marca, NO rechaza: descartar un escaneo por GPS impreciso en un
 *   subterraneo castigaria una condicion normal de trabajo. El supervisor decide.
 */
export class CreatePatrolScans1723734000000 implements MigrationInterface {
  name = 'CreatePatrolScans1723734000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE scans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        checkpoint_id uuid NOT NULL,
        tag_id uuid REFERENCES tags(id) ON DELETE SET NULL,
        method text NOT NULL CONSTRAINT scans_method_check CHECK (method IN ('nfc', 'qr')),
        client_scan_id uuid NOT NULL,
        scanned_at_device timestamptz,
        scanned_at_server timestamptz NOT NULL DEFAULT now(),
        latitude numeric(9,6),
        longitude numeric(9,6),
        accuracy_m numeric(7,2),
        anomalies jsonb NOT NULL DEFAULT '[]'::jsonb
          CONSTRAINT scans_anomalies_check CHECK (jsonb_typeof(anomalies) = 'array'),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, patrol_id, client_scan_id),
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES checkpoints(tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT scans_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT scans_longitude_check CHECK (longitude BETWEEN -180 AND 180)
      )
    `);
    await queryRunner.query(`CREATE INDEX scans_patrol_idx ON scans (tenant_id, patrol_id)`);
    await queryRunner.query(
      `CREATE INDEX scans_checkpoint_idx ON scans (tenant_id, checkpoint_id)`,
    );

    await queryRunner.query(`ALTER TABLE scans ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE scans FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY scans_isolation ON scans
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON scans TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE scans`);
  }
}
