import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Alertas operativas atendibles del supervisor (#98), separadas del correo de escalamiento. */
export class CreateOperationalAlerts1725548400000 implements MigrationInterface {
  name = 'CreateOperationalAlerts1725548400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE operational_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        patrol_id uuid,
        field_event_id uuid,
        alert_type text NOT NULL CONSTRAINT operational_alerts_type_check
          CHECK (alert_type IN ('no_iniciada', 'atrasada', 'incompleta', 'anomalia', 'incidente_grave')),
        severity text NOT NULL CONSTRAINT operational_alerts_severity_check
          CHECK (severity IN ('advertencia', 'critica')),
        dedupe_key text NOT NULL CONSTRAINT operational_alerts_dedupe_check
          CHECK (length(dedupe_key) BETWEEN 3 AND 200),
        title text NOT NULL CONSTRAINT operational_alerts_title_check
          CHECK (length(title) BETWEEN 3 AND 160),
        details text,
        detected_at timestamptz NOT NULL DEFAULT now(),
        attended_at timestamptz,
        attended_by uuid,
        attendance_comment text CONSTRAINT operational_alerts_comment_check
          CHECK (attendance_comment IS NULL OR length(trim(attendance_comment)) BETWEEN 2 AND 500),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, dedupe_key),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, field_event_id) REFERENCES field_events(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, attended_by) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT operational_alerts_attendance_check CHECK (
          (attended_at IS NULL AND attended_by IS NULL AND attendance_comment IS NULL)
          OR (attended_at IS NOT NULL AND attended_by IS NOT NULL AND attendance_comment IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX operational_alerts_board_idx
       ON operational_alerts (tenant_id, attended_at, detected_at DESC)`,
    );
    await queryRunner.query(`ALTER TABLE operational_alerts ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE operational_alerts FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY operational_alerts_isolation ON operational_alerts FOR ALL
      USING (tenant_id = app_tenant_id() OR app_has_audited_support_access(tenant_id))
      WITH CHECK (tenant_id = app_tenant_id())
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          GRANT SELECT, INSERT ON operational_alerts TO voxia_app;
          GRANT UPDATE (attended_at, attended_by, attendance_comment) ON operational_alerts TO voxia_app;
          REVOKE DELETE ON operational_alerts FROM voxia_app;
        END IF;
      END $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE operational_alerts`);
  }
}
