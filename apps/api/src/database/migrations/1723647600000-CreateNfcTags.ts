import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Etiquetas fisicas (NFC, con QR como respaldo) pegadas en los puntos de
 * control. Ver issue #54.
 *
 * Dos restricciones se aplican EN LA BASE, no en el codigo:
 *
 * 1. El UID es unico entre etiquetas ACTIVAS en todos los tenants. Asi una
 *    etiqueta de la empresa A no puede registrarse tambien en la B, aunque RLS
 *    impida verla: el indice unico parcial es global y el INSERT falla.
 * 2. Un punto tiene a lo mas UNA etiqueta activa por tecnologia: la NFC
 *    principal y su respaldo QR conviven, dos NFC activas no.
 *
 * El reemplazo conserva historial: la etiqueta anterior queda is_active=false
 * con replaced_at, nunca se borra.
 */
export class CreateNfcTags1723647600000 implements MigrationInterface {
  name = 'CreateNfcTags1723647600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tags (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        checkpoint_id uuid NOT NULL,
        tech text NOT NULL DEFAULT 'nfc'
          CONSTRAINT tags_tech_check CHECK (tech IN ('nfc', 'qr')),
        uid text NOT NULL
          CONSTRAINT tags_uid_length_check CHECK (length(uid) BETWEEN 4 AND 64),
        is_active boolean NOT NULL DEFAULT true,
        installed_at timestamptz NOT NULL DEFAULT now(),
        replaced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, checkpoint_id)
          REFERENCES checkpoints(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT tags_replaced_check CHECK (is_active = false OR replaced_at IS NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX tags_active_uid_uniq ON tags (uid) WHERE is_active`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX tags_checkpoint_tech_uniq
       ON tags (tenant_id, checkpoint_id, tech) WHERE is_active`,
    );
    await queryRunner.query(
      `CREATE INDEX tags_checkpoint_idx ON tags (tenant_id, checkpoint_id)`,
    );

    await queryRunner.query(`ALTER TABLE tags ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE tags FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tags_isolation ON tags
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tags`);
  }
}
