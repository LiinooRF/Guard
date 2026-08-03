import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Eventos en terreno: novedades y panico en UN solo modelo. Ver issues #123 y #124.
 *
 * El panico NO es una tabla aparte: es la criticidad maxima. Misma consulta,
 * misma bandeja, misma auditoria.
 *
 * Append-only DE VERDAD (#124): el GRANT de voxia_app es SOLO SELECT e INSERT.
 * Sin UPDATE ni DELETE a nivel de PostgreSQL, ni la API comprometida ni un
 * admin incomodo pueden reescribir la historia. El libro de novedades termina
 * en juicios laborales: una correccion es una ENTRADA NUEVA que referencia a
 * la anterior (corrects_event_id), y la original sigue visible.
 */
export class CreateFieldEvents1723820400000 implements MigrationInterface {
  name = 'CreateFieldEvents1723820400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE field_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        patrol_id uuid REFERENCES patrols(id) ON DELETE SET NULL,
        guard_id uuid NOT NULL,
        criticality text NOT NULL
          CONSTRAINT field_events_criticality_check
          CHECK (criticality IN ('info', 'baja', 'media', 'alta', 'panico')),
        text text
          CONSTRAINT field_events_text_check
          CHECK (criticality = 'panico' OR (text IS NOT NULL AND length(trim(text)) >= 3)),
        corrects_event_id uuid REFERENCES field_events(id),
        client_event_id uuid NOT NULL,
        latitude numeric(9,6),
        longitude numeric(9,6),
        accuracy_m numeric(7,2),
        reported_at_device timestamptz,
        reported_at_server timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, guard_id, client_event_id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT field_events_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT field_events_longitude_check CHECK (longitude BETWEEN -180 AND 180)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX field_events_site_idx ON field_events (tenant_id, site_id, reported_at_server DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX field_events_criticality_idx ON field_events (tenant_id, criticality)`,
    );

    await queryRunner.query(`ALTER TABLE field_events ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE field_events FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY field_events_isolation ON field_events
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
          -- SOLO SELECT e INSERT, a proposito: append-only aplicado en la base.
          GRANT SELECT, INSERT ON field_events TO voxia_app;
          REVOKE UPDATE, DELETE ON field_events FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE field_events`);
  }
}
