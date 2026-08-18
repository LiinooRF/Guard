import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Evidencia fotografica y horario habil (#13).
 *
 * `scan_photos`: una fila por foto de un escaneo. La UNIQUE (tenant_id, sha256)
 * es antifraude: la MISMA imagen reusada en otro punto o en otra ronda choca
 * con la constraint y la API responde 409. La captura solo-camara-nunca-galeria
 * es responsabilidad de la app movil (#67); del lado servidor queda registrado
 * `taken_at_device` para poder detectar fotos tomadas mucho antes del escaneo.
 *
 * `storage_path` es RELATIVO a EVIDENCE_PATH (tenant/ronda/sha.ext): mover el
 * volumen de evidencia no invalida las filas.
 *
 * La evidencia no se reescribe: el GRANT de sentrycore_app es SOLO SELECT e INSERT,
 * igual que field_events (#124). La retencion (photoRetentionDays en rules.ts)
 * la aplicara un proceso aparte con el rol dueño, no la API.
 *
 * `site_business_hours`: horario habil POR RECINTO (un mall y una bodega no
 * tienen el mismo). weekday 0=domingo..6=sabado, igual que businessHoursSchema
 * en @sentrycore/shared. Las horas son en la zona horaria DEL RECINTO
 * (sites.timezone). opens_at > closes_at significa tramo nocturno que cruza
 * medianoche (22:00-06:00); abre == cierra seria ambiguo y se prohibe.
 */
export class CreateScanPhotos1724080000000 implements MigrationInterface {
  name = 'CreateScanPhotos1724080000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE scan_photos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        scan_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        checkpoint_id uuid NOT NULL,
        storage_path text NOT NULL,
        mime_type text NOT NULL
          CONSTRAINT scan_photos_mime_check CHECK (mime_type IN ('image/jpeg', 'image/png')),
        size_bytes bigint NOT NULL
          CONSTRAINT scan_photos_size_check CHECK (size_bytes > 0),
        width integer CONSTRAINT scan_photos_width_check CHECK (width > 0),
        height integer CONSTRAINT scan_photos_height_check CHECK (height > 0),
        sha256 text NOT NULL
          CONSTRAINT scan_photos_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        taken_at_device timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, sha256),
        FOREIGN KEY (tenant_id, scan_id) REFERENCES scans(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES checkpoints(tenant_id, id) ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX scan_photos_patrol_idx ON scan_photos (tenant_id, patrol_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX scan_photos_scan_idx ON scan_photos (tenant_id, scan_id)`,
    );

    await queryRunner.query(`ALTER TABLE scan_photos ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE scan_photos FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY scan_photos_isolation ON scan_photos
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      CREATE TABLE site_business_hours (
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        weekday integer NOT NULL
          CONSTRAINT site_business_hours_weekday_check CHECK (weekday BETWEEN 0 AND 6),
        opens_at time NOT NULL,
        closes_at time NOT NULL,
        PRIMARY KEY (tenant_id, site_id, weekday),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT site_business_hours_range_check CHECK (opens_at <> closes_at)
      )
    `);

    await queryRunner.query(`ALTER TABLE site_business_hours ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE site_business_hours FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY site_business_hours_isolation ON site_business_hours
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- SOLO SELECT e INSERT, a proposito: la evidencia no se reescribe.
          GRANT SELECT, INSERT ON scan_photos TO sentrycore_app;
          REVOKE UPDATE, DELETE ON scan_photos FROM sentrycore_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON site_business_hours TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE site_business_hours`);
    await queryRunner.query(`DROP TABLE scan_photos`);
  }
}
