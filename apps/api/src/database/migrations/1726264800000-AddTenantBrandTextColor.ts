import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Color del texto que se dibuja sobre el color principal de cada tenant.
 *
 * La forma HEX se protege también en PostgreSQL. El contraste depende de la
 * pareja fondo/texto y se valida en BrandingService, donde puede evolucionar
 * con la norma WCAG sin congelar una fórmula en el esquema.
 */
export class AddTenantBrandTextColor1726264800000 implements MigrationInterface {
  name = 'AddTenantBrandTextColor1726264800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenant_branding
      ADD COLUMN primary_text_color text NOT NULL DEFAULT '#ffffff'
      CONSTRAINT tenant_branding_primary_text_check
      CHECK (primary_text_color ~* '^#[0-9a-f]{6}$')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenant_branding
      DROP COLUMN primary_text_color
    `);
  }
}

