import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resolver el codigo de empresa TAMBIEN necesita saltar RLS.
 *
 * `tenants` tiene FORCE ROW LEVEL SECURITY y el ingreso del guardia ocurre
 * ANTES de que exista contexto de empresa: un `SELECT id FROM tenants WHERE
 * slug = $1` desde el rol de la aplicacion devuelve CERO filas **sin error**.
 * El servicio lo leia como "esa empresa no existe" y respondia "codigo
 * incorrecto" en 14 ms, sin haber verificado nada.
 *
 * VA EN SU PROPIA MIGRACION, y no dentro de la que agrego las columnas, porque
 * aquella YA se aplico en produccion: TypeORM no vuelve a ejecutar una
 * migracion registrada, asi que editarla dejo la funcion sin crear y el
 * endpoint respondiendo 500. Una migracion aplicada es historia, no un archivo
 * que se corrige.
 *
 * Devuelve solo id y estado: lo justo para resolver el ingreso, nada mas de la
 * empresa.
 */
export class ResolverEmpresaPorCodigo1727388000000 implements MigrationInterface {
  name = 'ResolverEmpresaPorCodigo1727388000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tenant_por_codigo_de_empresa(codigo_empresa text)
      RETURNS TABLE (tenant_id uuid, tenant_status text)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT tenant.id, tenant.status
        FROM public.tenants tenant
        WHERE tenant.slug = codigo_empresa
        LIMIT 1
      $$
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION tenant_por_codigo_de_empresa(text) FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION tenant_por_codigo_de_empresa(text) TO sentrycore_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS tenant_por_codigo_de_empresa(text)`);
  }
}
