import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marca por tenant. Ver issues #117 y #118.
 *
 * El logo se guarda como texto (data URI o ruta en el volumen de evidencia), no
 * como bytea: un logo pesa poco y meterlo en la fila obligaria a excluir la
 * columna de cada SELECT para no arrastrarlo en consultas que no lo usan.
 *
 * Los colores se guardan en HEX y se validan con CHECK en la base ademas de en
 * el DTO. La validacion de CONTRASTE, en cambio, vive en la aplicacion: es una
 * formula (WCAG) y no una restriccion de forma, y ponerla en un CHECK la
 * congelaria en el esquema.
 */
export class CreateTenantBranding1724857200000 implements MigrationInterface {
  name = 'CreateTenantBranding1724857200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenant_branding (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        commercial_name text
          CONSTRAINT tenant_branding_name_check
          CHECK (commercial_name IS NULL OR length(trim(commercial_name)) BETWEEN 2 AND 80),
        logo_uri text,
        primary_color text NOT NULL DEFAULT '#1f3b73'
          CONSTRAINT tenant_branding_primary_check CHECK (primary_color ~* '^#[0-9a-f]{6}$'),
        secondary_color text NOT NULL DEFAULT '#4263eb'
          CONSTRAINT tenant_branding_secondary_check CHECK (secondary_color ~* '^#[0-9a-f]{6}$'),
        mail_from_name text
          CONSTRAINT tenant_branding_mail_name_check
          CHECK (mail_from_name IS NULL OR length(trim(mail_from_name)) BETWEEN 2 AND 80),
        mail_footer text
          CONSTRAINT tenant_branding_footer_check
          CHECK (mail_footer IS NULL OR length(mail_footer) <= 500),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_branding_isolation ON tenant_branding
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tenant_branding`);
  }
}
