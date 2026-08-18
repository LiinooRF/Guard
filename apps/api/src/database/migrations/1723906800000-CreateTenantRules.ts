import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Overrides de reglas por tenant (#16).
 *
 * La fila guarda SOLO las desviaciones respecto de los defaults de
 * `patrolRulesSchema` en @sentrycore/shared: sin fila (o con overrides vacios) el
 * tenant opera con los defaults del producto. Por eso NO se siembra una fila
 * por tenant ni se replican los defaults aca — si los defaults cambian en el
 * codigo, cambian para todos sin migrar datos.
 *
 * Es jsonb y no columnas: cada regla nueva en rules.ts entra sin ALTER TABLE.
 * El precio es que la base no valida rangos; eso lo hace RulesService campo a
 * campo, descartando lo invalido sin romper.
 */
export class CreateTenantRules1723906800000 implements MigrationInterface {
  name = 'CreateTenantRules1723906800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenant_rules (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        overrides jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT tenant_rules_overrides_object_check
          CHECK (jsonb_typeof(overrides) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE tenant_rules ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE tenant_rules FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_rules_isolation ON tenant_rules
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_rules TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tenant_rules`);
  }
}
