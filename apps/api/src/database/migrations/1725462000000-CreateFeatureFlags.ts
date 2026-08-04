import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Las dos tablas del modulo que llevan tenant_id, y por lo tanto RLS. */
const TENANT_TABLES = ['tenant_feature_grants', 'tenant_feature_preferences'] as const;

/**
 * Feature flags de modulos por tenant y por plan (#82).
 *
 * Esto es lo que permite vender planes distintos sin mantener versiones
 * distintas del producto. Hay DOS decisiones separadas y no se pueden mezclar:
 *
 *   1. QUE INCLUYE LA LICENCIA (el techo). Lo decide el SUPERADMIN, por plan de
 *      licencia (`plan_feature_flags`) o para una empresa puntual
 *      (`tenant_feature_grants`, que le gana al plan).
 *   2. QUE PRENDE LA EMPRESA (la preferencia). Lo decide el ADMIN dentro de lo
 *      que su licencia incluye (`tenant_feature_preferences`).
 *
 * Modulo efectivo = incluido en la licencia Y encendido por el admin. Un modulo
 * fuera de la licencia no queda "visible y bloqueado": desaparece.
 *
 * Igual que en las reglas (#16 y #80), las tres tablas guardan SOLO las
 * desviaciones respecto del nivel de arriba, en jsonb y no en columnas: un
 * modulo nuevo en featureFlagsSchema entra sin ALTER TABLE. Sin fila, ese nivel
 * no opina y manda el default del producto que vive en rules.ts.
 *
 * DONDE ESTA LA REJA DE VERDAD
 * ----------------------------
 * El servidor valida en el endpoint, pero el endpoint depende de un decorador
 * bien puesto. Por eso la base tambien lo impide, en dos capas:
 *
 *   - El techo NO se escribe con SQL suelto. voxia_app queda con SELECT y sin
 *     INSERT/UPDATE/DELETE sobre `plan_feature_flags` y `tenant_feature_grants`;
 *     se escriben por funciones SECURITY DEFINER que exigen SUPERADMIN activo.
 *     El REVOKE explicito es obligatorio: el script de init hace
 *     `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE`, asi
 *     que toda tabla nueva nace escribible y un GRANT SELECT no la achica.
 *   - Un trigger sobre `tenant_feature_preferences` rechaza guardar en true un
 *     modulo que la licencia niega explicitamente.
 *
 * `plan_feature_flags` es la unica tabla de este modulo SIN tenant_id, por la
 * misma razon que `platform_rules`: es el catalogo comercial de la PLATAFORMA,
 * comun a todas las empresas, no datos de ninguna. No hay nada que aislar.
 *
 * Supuesto heredado de platform_provision_tenant: el dueño del esquema —el rol
 * que corre las migraciones, separado de voxia_app— se salta RLS. Es lo que deja
 * que las funciones SECURITY DEFINER escriban tablas con FORCE ROW LEVEL
 * SECURITY sin contexto de tenant.
 */
export class CreateFeatureFlags1725462000000 implements MigrationInterface {
  name = 'CreateFeatureFlags1725462000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------
    // Techo por plan de licencia
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE plan_feature_flags (
        plan_key text PRIMARY KEY REFERENCES subscription_plans(key) ON DELETE CASCADE,
        flags jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT plan_feature_flags_object_check
          CHECK (jsonb_typeof(flags) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Una fila por plan existente y VACIA a proposito. Que modulos incluye cada
    // plan es una decision comercial, y el modelo de licencias sigue abierto en
    // el issue #2: sembrar un paquete aca seria cerrarlo por la puerta de atras.
    // Con la fila vacia el plan no opina y manda el default del producto; el
    // SUPERADMIN arma el paquete desde el panel.
    await queryRunner.query(`
      INSERT INTO plan_feature_flags (plan_key)
      SELECT plan.key FROM subscription_plans plan
      ON CONFLICT (plan_key) DO NOTHING
    `);

    // -----------------------------------------------------------------
    // Techo concedido a UNA empresa. Le gana al plan, para el caso real de
    // "se lo damos igual aunque no este en su plan" sin inventar un plan nuevo.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE tenant_feature_grants (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        grants jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT tenant_feature_grants_object_check
          CHECK (jsonb_typeof(grants) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // -----------------------------------------------------------------
    // Preferencia del ADMIN: lo unico de este modulo que escribe el tenant.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE tenant_feature_preferences (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        preferences jsonb NOT NULL DEFAULT '{}'::jsonb
          CONSTRAINT tenant_feature_preferences_object_check
          CHECK (jsonb_typeof(preferences) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const table of TENANT_TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }

    // La empresa LEE su licencia y no la escribe: sin politica de escritura, un
    // INSERT o UPDATE de voxia_app queda denegado por RLS aunque alguien le
    // devuelva el privilegio por error. Falla cerrada: app_tenant_id() es NULL
    // sin contexto y NULL no iguala a nada.
    await queryRunner.query(`
      CREATE POLICY tenant_feature_grants_read ON tenant_feature_grants
      FOR SELECT
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_feature_preferences_isolation ON tenant_feature_preferences
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    // -----------------------------------------------------------------
    // Techo efectivo de una empresa: lo del plan, pisado por su concesion.
    //
    // El jsonb NO trae todos los modulos: una clave ausente significa "este
    // nivel no opina", y ahi manda el default del producto, que la base no
    // conoce (vive en rules.ts). Por eso esta funcion se usa solo para lo que la
    // base SI puede afirmar: que un modulo esta negado explicitamente.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION tenant_feature_entitlements(target_tenant_id uuid)
      RETURNS jsonb
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT coalesce(flags_del_plan.flags, '{}'::jsonb)
               || coalesce(concesiones.grants, '{}'::jsonb)
        FROM public.tenants tenant
        LEFT JOIN public.plan_feature_flags flags_del_plan
          ON flags_del_plan.plan_key = tenant.plan_key
        LEFT JOIN public.tenant_feature_grants concesiones
          ON concesiones.tenant_id = tenant.id
        WHERE tenant.id = target_tenant_id
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION tenant_feature_preferences_within_license()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        permitido jsonb;
        bloqueados text;
      BEGIN
        permitido := public.tenant_feature_entitlements(NEW.tenant_id);

        SELECT string_agg(preferencia.key, ', ' ORDER BY preferencia.key)
          INTO bloqueados
          FROM jsonb_each(NEW.preferences) AS preferencia
         WHERE preferencia.value = 'true'::jsonb
           AND permitido -> preferencia.key = 'false'::jsonb;

        IF bloqueados IS NOT NULL THEN
          RAISE EXCEPTION 'modulo fuera de la licencia: %', bloqueados
            USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER tenant_feature_preferences_license_check
      BEFORE INSERT OR UPDATE ON tenant_feature_preferences
      FOR EACH ROW
      EXECUTE FUNCTION tenant_feature_preferences_within_license()
    `);

    // -----------------------------------------------------------------
    // Escritura del techo: solo SUPERADMIN activo, verificado por la base.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_set_plan_features(
        actor_id uuid,
        target_plan_key text,
        new_flags jsonb
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        guardado jsonb;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);

        IF jsonb_typeof(new_flags) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'los modulos del plan deben ser un objeto'
            USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.plan_feature_flags (plan_key, flags, updated_by)
        VALUES (target_plan_key, new_flags, actor_id)
        ON CONFLICT (plan_key) DO UPDATE SET
          flags = EXCLUDED.flags,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING plan_feature_flags.flags INTO guardado;

        RETURN guardado;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_set_tenant_features(
        actor_id uuid,
        target_tenant_id uuid,
        new_grants jsonb
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        guardado jsonb;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);

        IF jsonb_typeof(new_grants) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'las concesiones deben ser un objeto'
            USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.tenant_feature_grants (tenant_id, grants, updated_by)
        VALUES (target_tenant_id, new_grants, actor_id)
        ON CONFLICT (tenant_id) DO UPDATE SET
          grants = EXCLUDED.grants,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING tenant_feature_grants.grants INTO guardado;

        RETURN guardado;
      END
      $$
    `);

    // -----------------------------------------------------------------
    // Lectura desde plataforma. El SUPERADMIN no tiene tenant en su sesion, asi
    // que RLS le esconderia las concesiones y las preferencias: sin estas
    // funciones no podria ver lo que el mismo administra.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_list_plan_features(actor_id uuid)
      RETURNS TABLE (
        plan_key text,
        plan_name text,
        flags jsonb,
        tenant_count integer,
        updated_at timestamptz,
        updated_by uuid
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        SELECT
          plan.key,
          plan.name,
          coalesce(flags_del_plan.flags, '{}'::jsonb),
          (
            SELECT count(*)::integer
            FROM public.tenants tenant
            WHERE tenant.plan_key = plan.key
          ),
          flags_del_plan.updated_at,
          flags_del_plan.updated_by
        FROM public.subscription_plans plan
        LEFT JOIN public.plan_feature_flags flags_del_plan
          ON flags_del_plan.plan_key = plan.key
        ORDER BY plan.key;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_tenant_features(actor_id uuid, target_tenant_id uuid)
      RETURNS TABLE (
        tenant_id uuid,
        display_name text,
        plan_key text,
        plan_name text,
        plan_flags jsonb,
        tenant_grants jsonb,
        tenant_preferences jsonb
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        SELECT
          tenant.id,
          tenant.display_name,
          tenant.plan_key,
          plan.name,
          coalesce(flags_del_plan.flags, '{}'::jsonb),
          coalesce(concesiones.grants, '{}'::jsonb),
          coalesce(preferencias.preferences, '{}'::jsonb)
        FROM public.tenants tenant
        JOIN public.subscription_plans plan ON plan.key = tenant.plan_key
        LEFT JOIN public.plan_feature_flags flags_del_plan
          ON flags_del_plan.plan_key = tenant.plan_key
        LEFT JOIN public.tenant_feature_grants concesiones
          ON concesiones.tenant_id = tenant.id
        LEFT JOIN public.tenant_feature_preferences preferencias
          ON preferencias.tenant_id = tenant.id
        WHERE tenant.id = target_tenant_id;
      END
      $$
    `);

    for (const firma of [
      'tenant_feature_entitlements(uuid)',
      'tenant_feature_preferences_within_license()',
      'platform_set_plan_features(uuid, text, jsonb)',
      'platform_set_tenant_features(uuid, uuid, jsonb)',
      'platform_list_plan_features(uuid)',
      'platform_tenant_features(uuid, uuid)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          -- La preferencia del ADMIN es lo unico que el tenant escribe.
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_feature_preferences TO voxia_app;

          -- El techo se lee desde el tenant y se escribe solo por las funciones
          -- con control de SUPERADMIN. El REVOKE no sobra: el script de init deja
          -- ALTER DEFAULT PRIVILEGES con los cuatro verbos, asi que estas tablas
          -- nacen escribibles y sin esto el GRANT SELECT no restringe nada.
          GRANT SELECT ON plan_feature_flags TO voxia_app;
          GRANT SELECT ON tenant_feature_grants TO voxia_app;
          REVOKE INSERT, UPDATE, DELETE ON plan_feature_flags FROM voxia_app;
          REVOKE INSERT, UPDATE, DELETE ON tenant_feature_grants FROM voxia_app;

          -- tenant_feature_entitlements queda SIN grant: la usa el trigger desde
          -- adentro, con los privilegios del dueño. Expuesta, dejaria consultar
          -- el paquete comercial de cualquier empresa por su uuid.
          GRANT EXECUTE ON FUNCTION platform_set_plan_features(uuid, text, jsonb) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_set_tenant_features(uuid, uuid, jsonb) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_list_plan_features(uuid) TO voxia_app;
          GRANT EXECUTE ON FUNCTION platform_tenant_features(uuid, uuid) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION platform_tenant_features(uuid, uuid)`);
    await queryRunner.query(`DROP FUNCTION platform_list_plan_features(uuid)`);
    await queryRunner.query(`DROP FUNCTION platform_set_tenant_features(uuid, uuid, jsonb)`);
    await queryRunner.query(`DROP FUNCTION platform_set_plan_features(uuid, text, jsonb)`);
    // La tabla se lleva su trigger; recien despues se puede soltar la funcion.
    await queryRunner.query(`DROP TABLE tenant_feature_preferences`);
    await queryRunner.query(`DROP FUNCTION tenant_feature_preferences_within_license()`);
    await queryRunner.query(`DROP TABLE tenant_feature_grants`);
    await queryRunner.query(`DROP FUNCTION tenant_feature_entitlements(uuid)`);
    await queryRunner.query(`DROP TABLE plan_feature_flags`);
  }
}
