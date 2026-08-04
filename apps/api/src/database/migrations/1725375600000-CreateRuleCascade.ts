import type { MigrationInterface, QueryRunner } from 'typeorm';

const TENANT_TABLES = ['site_rules', 'checkpoint_rules'] as const;

/**
 * Cascada de configuracion persistida (#80).
 *
 *     plataforma  ->  tenant  ->  recinto  ->  punto     (gana el mas especifico)
 *
 * El nivel de tenant ya existia en `tenant_rules` (#16) y NO se toca: esta
 * migracion agrega los dos extremos que faltaban. Cada tabla guarda SOLO las
 * desviaciones respecto del nivel de arriba — sin fila, ese nivel simplemente no
 * opina y el valor lo pone el nivel anterior. Por eso no se siembra una fila por
 * recinto ni por punto: un tenant nuevo opera con los defaults del producto sin
 * configurar nada.
 *
 * jsonb y no columnas, mismo criterio que tenant_rules: cada regla nueva de
 * rules.ts entra sin ALTER TABLE. La base valida la FORMA (que sea un objeto);
 * los rangos los valida RulesService campo a campo contra patrolRulesSchema,
 * descartando lo invalido sin romper la operacion en terreno.
 *
 * `platform_rules` es la unica tabla del modelo SIN tenant_id, y es a proposito:
 * es el nivel de la PLATAFORMA, comun a todas las empresas, del mismo tipo de
 * dato que DEFAULT_PATROL_RULES en el codigo (que ya se publica en el endpoint
 * publico /api/rules/defaults). No lleva RLS porque no hay nada que aislar: no
 * contiene datos de ningun tenant. Lo que si tiene es control de escritura —
 * voxia_app recibe SELECT y nada mas, y el UPDATE pasa por platform_set_rules(),
 * que exige SUPERADMIN activo igual que el resto de las funciones de plataforma.
 * Asi, aunque un endpoint quedara mal decorado, un ADMIN de un tenant no puede
 * cambiarle los defaults a todo el SaaS.
 */
export class CreateRuleCascade1725375600000 implements MigrationInterface {
  name = 'CreateRuleCascade1725375600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Nivel plataforma: una sola fila, garantizada por el CHECK del PK ----
    await queryRunner.query(`
      CREATE TABLE platform_rules (
        id boolean PRIMARY KEY DEFAULT true
          CONSTRAINT platform_rules_singleton_check CHECK (id),
        overrides jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT platform_rules_overrides_object_check
          CHECK (jsonb_typeof(overrides) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // La fila existe desde el minuto cero: asi la lectura de la cascada es un
    // SELECT sin upsert previo, y el estado "sin configurar" es {} y no NULL.
    await queryRunner.query(`INSERT INTO platform_rules (id) VALUES (true)`);

    await queryRunner.query(`
      CREATE FUNCTION platform_set_rules(actor_id uuid, new_overrides jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        guardado jsonb;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);

        IF jsonb_typeof(new_overrides) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'las reglas de plataforma deben ser un objeto'
            USING ERRCODE = '22023';
        END IF;

        UPDATE public.platform_rules
           SET overrides = new_overrides,
               updated_at = now(),
               updated_by = actor_id
         WHERE id
        RETURNING overrides INTO guardado;

        RETURN guardado;
      END
      $$
    `);

    // ---- Niveles recinto y punto: tenant_id + RLS, como toda tabla de negocio ----
    await queryRunner.query(`
      CREATE TABLE site_rules (
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        overrides jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT site_rules_overrides_object_check
          CHECK (jsonb_typeof(overrides) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, site_id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE checkpoint_rules (
        tenant_id uuid NOT NULL,
        checkpoint_id uuid NOT NULL,
        overrides jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT checkpoint_rules_overrides_object_check
          CHECK (jsonb_typeof(overrides) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, checkpoint_id),
        FOREIGN KEY (tenant_id, checkpoint_id)
          REFERENCES checkpoints(tenant_id, id) ON DELETE CASCADE
      )
    `);

    for (const table of TENANT_TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_isolation ON ${table}
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
          GRANT SELECT, INSERT, UPDATE, DELETE ON site_rules, checkpoint_rules TO voxia_app;

          -- La plataforma se LEE desde cualquier request (la cascada la necesita)
          -- pero solo se escribe por la funcion con control de SUPERADMIN.
          GRANT SELECT ON platform_rules TO voxia_app;
          REVOKE ALL ON FUNCTION platform_set_rules(uuid, jsonb) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION platform_set_rules(uuid, jsonb) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE checkpoint_rules`);
    await queryRunner.query(`DROP TABLE site_rules`);
    await queryRunner.query(`DROP FUNCTION platform_set_rules(uuid, jsonb)`);
    await queryRunner.query(`DROP TABLE platform_rules`);
  }
}
