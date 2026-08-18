import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cadena de escalamiento configurable por criticidad (#126) y falsa alarma (#127).
 *
 * Hasta ahora, alta y panico avisaban a TODOS los admins del tenant: un
 * placeholder. La empresa de seguridad real tiene una cadena — supervisor de
 * turno primero, jefe de operaciones si nadie contesta en X minutos — y necesita
 * saber QUIEN se hizo cargo. Eso es escalation_policies (la cadena) y
 * event_notifications (el acuse de recibo).
 *
 * SOBRE #127 (falsa alarma): NO se agregan columnas false_alarm_at /
 * false_alarm_reason / false_alarm_by a field_events. Esa tabla es append-only
 * en PostgreSQL — sentrycore_app tiene SELECT e INSERT y nada mas (ver
 * 1723820400000-CreateFieldEvents) — asi que un UPDATE sobre esas columnas
 * fallaria con 42501 en produccion. Darle UPDATE a sentrycore_app para lograrlo
 * derribaria la garantia que hace que el libro de novedades sirva como prueba
 * en un juicio laboral. La cancelacion se registra como una ENTRADA NUEVA de
 * criticidad 'info' con corrects_event_id apuntando al panico original: el
 * mecanismo de correccion que la tabla ya tiene desde #124.
 */
export class CreateEscalation1724338800000 implements MigrationInterface {
  name = 'CreateEscalation1724338800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE escalation_policies (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        criticality text NOT NULL
          CONSTRAINT escalation_policies_criticality_check
          CHECK (criticality IN ('media', 'alta', 'panico')),
        level smallint NOT NULL
          CONSTRAINT escalation_policies_level_check CHECK (level BETWEEN 1 AND 3),
        -- Destino por ROL (se resuelve a las personas vigentes al momento del
        -- evento) o por correo fijo (central de monitoreo externa, que no es
        -- usuario del sistema). Exactamente uno de los dos.
        notify_role text
          CONSTRAINT escalation_policies_role_check
          CHECK (notify_role IN ('SUPERVISOR', 'ADMIN')),
        notify_email text
          CONSTRAINT escalation_policies_email_check
          CHECK (notify_email IS NULL OR position('@' in notify_email) > 1),
        -- Minutos sin acuse antes de que este nivel entre. 0 = inmediato.
        delay_minutes integer NOT NULL DEFAULT 0
          CONSTRAINT escalation_policies_delay_check
          CHECK (delay_minutes BETWEEN 0 AND 1440),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, criticality, level),
        CONSTRAINT escalation_policies_target_check
          CHECK (num_nonnulls(notify_role, notify_email) = 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE event_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        field_event_id uuid NOT NULL,
        level smallint NOT NULL
          CONSTRAINT event_notifications_level_check CHECK (level BETWEEN 1 AND 3),
        -- Nulo cuando el destino es un correo fijo sin usuario detras.
        recipient_user_id uuid,
        recipient_email text NOT NULL
          CONSTRAINT event_notifications_email_check
          CHECK (position('@' in recipient_email) > 1),
        sent_at timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz,
        acknowledged_by uuid,
        UNIQUE (tenant_id, id),
        -- Reintentar el mismo nivel al mismo destinatario no duplica el acuse.
        UNIQUE (tenant_id, field_event_id, level, recipient_email),
        FOREIGN KEY (tenant_id, field_event_id)
          REFERENCES field_events(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, recipient_user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, acknowledged_by)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT event_notifications_ack_check
          CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
      )
    `);
    // La consulta del job que sube de nivel: lo pendiente sin acuse, por antiguedad.
    await queryRunner.query(
      `CREATE INDEX event_notifications_pending_idx
       ON event_notifications (tenant_id, sent_at)
       WHERE acknowledged_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX event_notifications_event_idx
       ON event_notifications (tenant_id, field_event_id, level)`,
    );

    for (const tabla of ['escalation_policies', 'event_notifications']) {
      await queryRunner.query(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${tabla}_isolation ON ${tabla}
        FOR ALL
        USING (
          tenant_id = app_tenant_id()
          OR app_has_audited_support_access(tenant_id)
        )
        WITH CHECK (tenant_id = app_tenant_id())
      `);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- La cadena se reemplaza completa al guardarla: necesita DELETE.
          GRANT SELECT, INSERT, UPDATE, DELETE ON escalation_policies TO sentrycore_app;
          -- Sin DELETE: el acuse es evidencia de quien se hizo cargo de un
          -- panico. Se marca, no se borra.
          GRANT SELECT, INSERT, UPDATE ON event_notifications TO sentrycore_app;
          REVOKE DELETE ON event_notifications FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE event_notifications`);
    await queryRunner.query(`DROP TABLE escalation_policies`);
  }
}
