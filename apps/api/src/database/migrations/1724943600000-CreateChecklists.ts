import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checklists configurables por recinto y turno (#129).
 *
 * El checklist es la otra mitad de la ronda: la etiqueta NFC prueba que el
 * guardia ESTUVO en el punto, el checklist registra QUE ENCONTRO ahi. Es
 * configuracion del tenant, no del codigo: cada empresa (y cada recinto de una
 * misma empresa) revisa cosas distintas.
 *
 * ALCANCE DE UNA PLANTILLA — se resuelve de lo mas especifico a lo mas general:
 *
 *     recinto + turno   ->   recinto   ->   toda la empresa
 *
 * `site_id` nulo significa "toda la empresa" y `shift_id` nulo "cualquier
 * turno". Un turno pertenece a un recinto, asi que un shift_id sin site_id seria
 * un alcance sin sentido y lo prohibe un CHECK: sin eso, la resolucion tendria
 * dos ramas de la misma especificidad y "la plantilla vigente" dependeria del
 * orden en que PostgreSQL devolviera las filas.
 *
 * El indice unico parcial `checklist_templates_scope_idx` es lo que hace
 * DETERMINISTA esa resolucion: a lo sumo una plantilla ACTIVA por alcance. Sin
 * el, dos plantillas activas del mismo recinto convertirian la eleccion en un
 * empate silencioso. Usa NULLS NOT DISTINCT (PostgreSQL 15+, la imagen del
 * stack es postgres:17-alpine) porque justamente los nulos del alcance son
 * valores con significado, no "desconocido".
 *
 * LAS RESPUESTAS SON EVIDENCIA. El GRANT de voxia_app sobre checklist_responses
 * es SOLO SELECT e INSERT, igual que field_events (#124) y scan_photos (#13):
 * una falla reportada no se puede convertir despues en un "ok". El reenvio
 * offline es idempotente por (tenant, ronda, item), asi que reintentar no
 * necesita UPDATE. Corregir una respuesta es reportar una novedad en el libro,
 * que es append-only y queda al lado de la original.
 */
export class CreateChecklists1724943600000 implements MigrationInterface {
  name = 'CreateChecklists1724943600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE checklist_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Nulo = aplica a toda la empresa.
        site_id uuid,
        -- Nulo = aplica a cualquier turno del recinto.
        shift_id uuid,
        name text NOT NULL
          CONSTRAINT checklist_templates_name_check
          CHECK (length(trim(name)) BETWEEN 2 AND 120),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT checklist_templates_scope_check
          CHECK (shift_id IS NULL OR site_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX checklist_templates_scope_idx
        ON checklist_templates (tenant_id, site_id, shift_id)
        NULLS NOT DISTINCT
        WHERE is_active
    `);

    await queryRunner.query(`
      CREATE TABLE checklist_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        template_id uuid NOT NULL,
        position integer NOT NULL
          CONSTRAINT checklist_items_position_check CHECK (position >= 1),
        label text NOT NULL
          CONSTRAINT checklist_items_label_check
          CHECK (length(trim(label)) BETWEEN 2 AND 200),
        -- 'ok_falla' es el caso normal y el unico que la aplicacion interpreta
        -- sola: 'falla' dispara el aviso al supervisor. 'texto' y 'numero'
        -- registran lecturas (nivel de estanque, presion del extintor) y ahi la
        -- falla la declara quien responde.
        response_type text NOT NULL
          CONSTRAINT checklist_items_response_type_check
          CHECK (response_type IN ('ok_falla', 'texto', 'numero')),
        requires_photo_on_fail boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, template_id, position),
        FOREIGN KEY (tenant_id, template_id)
          REFERENCES checklist_templates(tenant_id, id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE checklist_responses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        item_id uuid NOT NULL,
        value text NOT NULL
          CONSTRAINT checklist_responses_value_check
          CHECK (length(trim(value)) BETWEEN 1 AND 500),
        notes text
          CONSTRAINT checklist_responses_notes_check
          CHECK (notes IS NULL OR length(notes) <= 500),
        failed boolean NOT NULL DEFAULT false,
        -- Evidencia de la falla cuando el item la exige. Sin esta columna,
        -- requires_photo_on_fail solo lo podria hacer cumplir el telefono, que
        -- es la parte menos confiable del sistema.
        photo_id uuid,
        responded_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        -- Un item se responde una vez por ronda: hace idempotente el reenvio
        -- del lote offline con ON CONFLICT DO NOTHING.
        UNIQUE (tenant_id, patrol_id, item_id),
        FOREIGN KEY (tenant_id, patrol_id)
          REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        -- RESTRICT: borrar un item con respuestas dejaria la evidencia sin la
        -- pregunta que se respondio.
        FOREIGN KEY (tenant_id, item_id)
          REFERENCES checklist_items(tenant_id, id) ON DELETE RESTRICT,
        -- La lista de columnas del SET NULL es obligatoria (PostgreSQL 15+): sin
        -- ella tambien anularia tenant_id, que es NOT NULL, y la purga por
        -- retencion de fotos fallaria.
        FOREIGN KEY (tenant_id, photo_id)
          REFERENCES scan_photos(tenant_id, id) ON DELETE SET NULL (photo_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX checklist_responses_patrol_idx
       ON checklist_responses (tenant_id, patrol_id)`,
    );
    // Lo que mira el supervisor: las fallas recientes, primero las nuevas.
    await queryRunner.query(
      `CREATE INDEX checklist_responses_failed_idx
       ON checklist_responses (tenant_id, responded_at DESC)
       WHERE failed`,
    );

    for (const tabla of ['checklist_templates', 'checklist_items', 'checklist_responses']) {
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          -- Sin DELETE: una plantilla no se borra, se desactiva. Sus items
          -- siguen siendo la pregunta que respondieron rondas ya cerradas.
          GRANT SELECT, INSERT, UPDATE ON checklist_templates TO voxia_app;
          REVOKE DELETE ON checklist_templates FROM voxia_app;
          -- Los items si se reemplazan, pero solo mientras la plantilla no tenga
          -- respuestas; el FK RESTRICT es el respaldo de esa regla.
          GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_items TO voxia_app;
          -- Evidencia: se escribe una vez y no se reescribe.
          GRANT SELECT, INSERT ON checklist_responses TO voxia_app;
          REVOKE UPDATE, DELETE ON checklist_responses FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE checklist_responses`);
    await queryRunner.query(`DROP TABLE checklist_items`);
    await queryRunner.query(`DROP TABLE checklist_templates`);
  }
}
