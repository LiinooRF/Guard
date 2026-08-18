import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fotos del libro de novedades (#122).
 *
 * Tabla aparte de scan_photos y no una columna nullable ahi: scan_photos exige
 * scan_id, patrol_id y checkpoint_id NOT NULL con FK compuesta, y una novedad
 * puede no tener ronda —el guardia reporta un vidrio roto al llegar, antes de
 * iniciar—. Aflojar esas tres columnas a NULL debilitaria la integridad de la
 * evidencia de ronda para acomodar un caso que no es el suyo.
 *
 * APPEND-ONLY como el libro que respalda: se otorga SELECT e INSERT y se revoca
 * UPDATE y DELETE al rol de la aplicacion. El libro de novedades termina en
 * juicios laborales; una foto que se puede reemplazar despues no sirve como
 * prueba, y "no vamos a borrarla" no es un control, es una intencion.
 */
export class CreateEventPhotos1725116400000 implements MigrationInterface {
  name = 'CreateEventPhotos1725116400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE event_photos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        event_id uuid NOT NULL,
        storage_path text NOT NULL,
        mime_type text NOT NULL
          CONSTRAINT event_photos_mime_check CHECK (mime_type IN ('image/jpeg', 'image/png')),
        size_bytes bigint NOT NULL
          CONSTRAINT event_photos_size_check CHECK (size_bytes > 0),
        width integer CONSTRAINT event_photos_width_check CHECK (width > 0),
        height integer CONSTRAINT event_photos_height_check CHECK (height > 0),
        sha256 text NOT NULL
          CONSTRAINT event_photos_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        taken_at_device timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, event_id) REFERENCES field_events(tenant_id, id) ON DELETE CASCADE
      )
    `);

    // Sirve al listado del libro: las fotos de una novedad, en orden de captura.
    await queryRunner.query(
      `CREATE INDEX event_photos_event_idx ON event_photos (tenant_id, event_id, created_at)`,
    );

    /*
     * Misma imagen dos veces DENTRO del tenant = foto reusada. Es unico parcial
     * por tenant y no global: dos empresas distintas pueden fotografiar la misma
     * senaletica generica sin que una le bloquee la evidencia a la otra.
     *
     * Ademas hace el rechazo atomico: sin esto, dos subidas simultaneas del
     * mismo contenido pasan las dos el SELECT previo y quedan las dos.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX event_photos_sha_unique ON event_photos (tenant_id, sha256)`,
    );

    await queryRunner.query(`ALTER TABLE event_photos ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE event_photos FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY event_photos_isolation ON event_photos
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
          GRANT SELECT, INSERT ON event_photos TO sentrycore_app;
          REVOKE UPDATE, DELETE ON event_photos FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE event_photos`);
  }
}
