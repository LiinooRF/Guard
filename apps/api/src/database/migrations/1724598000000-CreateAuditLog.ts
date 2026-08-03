import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auditoria de acciones sensibles del tenant. Ver issue #104.
 *
 * Append-only a nivel de PostgreSQL, igual que field_events: voxia_app recibe
 * SELECT e INSERT y nada mas. Un registro de auditoria que la propia aplicacion
 * puede editar no sirve para reconstruir quien cambio que — y "el sistema lo
 * permitia" es lo primero que alega quien fue auditado.
 *
 * El actor se guarda por id Y por descripcion textual: si el usuario se elimina
 * despues, la fila debe seguir diciendo quien fue. Por eso actor_id no lleva FK.
 */
export class CreateAuditLog1724598000000 implements MigrationInterface {
  name = 'CreateAuditLog1724598000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        actor_id uuid,
        actor_label text NOT NULL,
        action text NOT NULL
          CONSTRAINT audit_log_action_check CHECK (length(trim(action)) > 0),
        entity_type text NOT NULL,
        entity_id uuid,
        summary text,
        request_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX audit_log_actor_idx ON audit_log (tenant_id, actor_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX audit_log_action_idx ON audit_log (tenant_id, action, created_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE audit_log FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY audit_log_isolation ON audit_log
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
          -- Solo SELECT e INSERT: la auditoria no se corrige, se acumula.
          GRANT SELECT, INSERT ON audit_log TO voxia_app;
          REVOKE UPDATE, DELETE ON audit_log FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE audit_log`);
  }
}
