import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Borrado y exportacion completa de un tenant (issue #33, ley 21.719).
 *
 * tenant_deletions es tabla de PLATAFORMA, no de negocio: la consulta el
 * SUPERADMIN, que por definicion no tiene contexto de tenant. Una politica de
 * aislamiento por app_tenant_id() dejaria cada fila invisible para su unico
 * consumidor. Por eso va SIN RLS, con el mismo criterio que
 * platform_memberships (que tampoco lo tiene) y control de acceso por GRANT:
 * solo sentrycore_app, y sin DELETE — una solicitud no se borra, se cancela.
 *
 * tenant_id NO lleva FK a tenants a proposito: esta fila es la prueba juridica
 * de que el borrado se pidio y se ejecuto, y debe sobrevivir al purge del
 * tenant al que apunta.
 *
 * Las funciones SECURITY DEFINER siguen el patron ya sancionado de
 * platform_list_tenants/platform_create_tenant: sentrycore_app sin contexto tenant
 * no ve ninguna fila por RLS, asi que el cruce de tenants ocurre solo dentro
 * de funciones que exigen assert_platform_superadmin.
 */
export class CreateTenantDeletions1724166000000 implements MigrationInterface {
  name = 'CreateTenantDeletions1724166000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenant_deletions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Se llama target_tenant_id, NO tenant_id, a proposito: esta fila no
        -- pertenece a una empresa, habla SOBRE una empresa. Es un registro de
        -- plataforma que consulta el SUPERADMIN, que no tiene contexto de
        -- tenant. Si la columna se llamara tenant_id, la invariante del
        -- producto ("toda tabla con tenant_id lleva RLS") quedaria violada y
        -- el test de aislamiento la marcaria — con razon.
        target_tenant_id uuid NOT NULL,
        requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        requested_at timestamptz NOT NULL DEFAULT now(),
        purge_after timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'programado'
          CONSTRAINT tenant_deletions_status_check
          CHECK (status IN ('programado', 'cancelado', 'ejecutado')),
        reason text NOT NULL
          CONSTRAINT tenant_deletions_reason_check
          CHECK (length(trim(reason)) >= 10),
        executed_at timestamptz,
        CONSTRAINT tenant_deletions_retention_check CHECK (purge_after > requested_at),
        CONSTRAINT tenant_deletions_executed_check
          CHECK (executed_at IS NULL OR status = 'ejecutado')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX tenant_deletions_one_scheduled_idx
      ON tenant_deletions (target_tenant_id)
      WHERE status = 'programado'
    `);
    await queryRunner.query(`
      CREATE INDEX tenant_deletions_pending_idx
      ON tenant_deletions (purge_after)
      WHERE status = 'programado'
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_export_tenant_table(
        actor_id uuid,
        target_tenant_id uuid,
        target_table text
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        result jsonb;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        -- Valida contra el catalogo antes de interpolar: %I solo recibe
        -- nombres que existen como tabla base con columna tenant_id.
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns columns
          JOIN information_schema.tables tables
            ON tables.table_schema = columns.table_schema
           AND tables.table_name = columns.table_name
          WHERE columns.table_schema = 'public'
            AND columns.table_name = target_table
            AND columns.column_name = 'tenant_id'
            AND tables.table_type = 'BASE TABLE'
        ) THEN
          RAISE EXCEPTION 'tabla % no es una tabla tenant valida', target_table
            USING ERRCODE = '22023';
        END IF;
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(fila)), ''[]''::jsonb)
           FROM public.%I fila WHERE fila.tenant_id = $1',
          target_table
        ) INTO result USING target_tenant_id;
        RETURN result;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_count_tenant_rows(
        actor_id uuid,
        target_tenant_id uuid,
        target_table text
      )
      RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        remaining bigint;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns columns
          JOIN information_schema.tables tables
            ON tables.table_schema = columns.table_schema
           AND tables.table_name = columns.table_name
          WHERE columns.table_schema = 'public'
            AND columns.table_name = target_table
            AND columns.column_name = 'tenant_id'
            AND tables.table_type = 'BASE TABLE'
        ) THEN
          RAISE EXCEPTION 'tabla % no es una tabla tenant valida', target_table
            USING ERRCODE = '22023';
        END IF;
        EXECUTE format(
          'SELECT count(*) FROM public.%I fila WHERE fila.tenant_id = $1',
          target_table
        ) INTO remaining USING target_tenant_id;
        RETURN remaining;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_purge_tenant(actor_id uuid, target_tenant_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        -- platform_audit_log referencia tenants con RESTRICT y todo tenant
        -- creado por la plataforma tiene su fila 'tenant.created': sin este
        -- DELETE previo ningun tenant real podria purgarse jamas. La prueba
        -- juridica del borrado no se pierde: queda en tenant_deletions, que
        -- no tiene FK y sobrevive.
        DELETE FROM public.platform_audit_log WHERE tenant_id = target_tenant_id;
        DELETE FROM public.tenants WHERE id = target_tenant_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- Sin DELETE: cancelar es un UPDATE de estado, el historial queda.
          GRANT SELECT, INSERT, UPDATE ON tenant_deletions TO sentrycore_app;
          REVOKE ALL ON FUNCTION platform_export_tenant_table(uuid, uuid, text) FROM PUBLIC;
          REVOKE ALL ON FUNCTION platform_count_tenant_rows(uuid, uuid, text) FROM PUBLIC;
          REVOKE ALL ON FUNCTION platform_purge_tenant(uuid, uuid) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION platform_export_tenant_table(uuid, uuid, text) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION platform_count_tenant_rows(uuid, uuid, text) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION platform_purge_tenant(uuid, uuid) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION platform_purge_tenant(uuid, uuid)`);
    await queryRunner.query(`DROP FUNCTION platform_count_tenant_rows(uuid, uuid, text)`);
    await queryRunner.query(`DROP FUNCTION platform_export_tenant_table(uuid, uuid, text)`);
    await queryRunner.query(`DROP TABLE tenant_deletions`);
  }
}
