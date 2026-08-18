import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El aislamiento de verdad se prueba contra Postgres en
 * tenant-isolation.integration.spec.ts, pero ese test se salta cuando no hay
 * base, que es la mayoria de las corridas. Esto verifica sobre el TEXTO de la
 * migracion lo que no se puede dejar al olvido:
 *
 *   - ENABLE **y** FORCE en las dos tablas con tenant_id, y politica que falla
 *     cerrada;
 *   - que el techo de la licencia no se pueda escribir con un UPDATE suelto del
 *     rol de aplicacion — incluido el REVOKE, porque el script de init deja
 *     ALTER DEFAULT PRIVILEGES con los cuatro verbos y sin el REVOKE un
 *     GRANT SELECT no restringe nada;
 *   - que cada SQL tenga los parentesis y las comillas balanceados. Un
 *     parentesis de mas lo rechaza Postgres SIEMPRE y ningun mock lo ve.
 */
const RUTA = join(
  __dirname,
  '../database/migrations/1725462000000-CreateFeatureFlags.ts',
);
const SQL = readFileSync(RUTA, 'utf8');

/** Los literales de plantilla del archivo, que es donde vive el SQL. */
const LITERALES = (SQL.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));

describe('migracion de feature flags', () => {
  it.each(['tenant_feature_grants', 'tenant_feature_preferences'])(
    '%s lleva tenant_id y entra al bucle de RLS',
    (tabla) => {
      expect(SQL).toContain(`CREATE TABLE ${tabla}`);
      expect(SQL).toMatch(new RegExp(`const TENANT_TABLES[^;]*'${tabla}'`, 's'));
    },
  );

  it('el bucle de RLS hace ENABLE y ademas FORCE', () => {
    expect(SQL).toContain('ENABLE ROW LEVEL SECURITY');
    expect(SQL).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('las politicas aislan por tenant y fallan cerradas', () => {
    expect(SQL).toContain('tenant_id = app_tenant_id()');
    expect(SQL).toContain('app_has_audited_support_access(tenant_id)');
    expect(SQL).toContain('WITH CHECK (tenant_id = app_tenant_id())');
  });

  it('la licencia de la empresa se LEE pero no se escribe desde el tenant', () => {
    // Politica solo de SELECT: sin politica de escritura, RLS deniega el INSERT
    // y el UPDATE aunque alguien devuelva el privilegio por error.
    expect(SQL).toContain('CREATE POLICY tenant_feature_grants_read ON tenant_feature_grants');
    expect(SQL).toContain('FOR SELECT');
    expect(SQL).not.toMatch(/CREATE POLICY[^;]*ON tenant_feature_grants[^;]*FOR ALL/s);
  });

  it('el techo no se puede escribir con SQL suelto del rol de aplicacion', () => {
    for (const tabla of ['plan_feature_flags', 'tenant_feature_grants']) {
      expect(SQL).toContain(`GRANT SELECT ON ${tabla} TO sentrycore_app`);
      expect(SQL).toContain(`REVOKE INSERT, UPDATE, DELETE ON ${tabla} FROM sentrycore_app`);
    }
  });

  it('las funciones de plataforma exigen SUPERADMIN activo dentro de la base', () => {
    const definiciones = (SQL.match(/PERFORM public\.assert_platform_superadmin\(actor_id\)/g) ?? [])
      .length;
    // set_plan_features, set_tenant_features, list_plan_features y tenant_features
    expect(definiciones).toBe(4);
    expect(SQL).toContain('SECURITY DEFINER');
  });

  it('el trigger impide guardar prendido un modulo que la licencia niega', () => {
    expect(SQL).toContain('CREATE TRIGGER tenant_feature_preferences_license_check');
    expect(SQL).toContain('BEFORE INSERT OR UPDATE ON tenant_feature_preferences');
    expect(SQL).toContain("USING ERRCODE = '42501'");
  });

  it('tenant_feature_entitlements no queda expuesta al rol de aplicacion', () => {
    // Con EXECUTE, cualquiera podria consultar el paquete comercial de otra
    // empresa por su uuid: la funcion es SECURITY DEFINER y se salta RLS.
    expect(SQL).toMatch(
      /for \(const firma of \[[^\]]*'tenant_feature_entitlements\(uuid\)'/s,
    );
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION \$\{firma\} FROM PUBLIC/);
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION tenant_feature_entitlements/);
  });

  it('los grants estan detras del chequeo del rol de aplicacion', () => {
    expect(SQL).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app')");
  });

  it('no siembra un paquete comercial: el modelo de licencias sigue abierto (#2)', () => {
    // Una fila por plan, vacia. Que incluye cada plan lo decide el SUPERADMIN.
    expect(SQL).toContain('INSERT INTO plan_feature_flags (plan_key)');
    expect(SQL).not.toMatch(/INSERT INTO plan_feature_flags[^`]*'\{"/s);
  });

  it('se puede revertir', () => {
    for (const sentencia of [
      'DROP FUNCTION platform_tenant_features(uuid, uuid)',
      'DROP FUNCTION platform_list_plan_features(uuid)',
      'DROP FUNCTION platform_set_tenant_features(uuid, uuid, jsonb)',
      'DROP FUNCTION platform_set_plan_features(uuid, text, jsonb)',
      'DROP TABLE tenant_feature_preferences',
      'DROP FUNCTION tenant_feature_preferences_within_license()',
      'DROP TABLE tenant_feature_grants',
      'DROP FUNCTION tenant_feature_entitlements(uuid)',
      'DROP TABLE plan_feature_flags',
    ]) {
      expect(SQL).toContain(sentencia);
    }
  });

  it('cada SQL tiene los parentesis y las comillas balanceados', () => {
    const rotos = LITERALES.filter((cuerpo) => {
      if (!/SELECT|CREATE|ALTER|GRANT|REVOKE|DROP|INSERT/.test(cuerpo)) return false;
      let abiertos = 0;
      let minimo = 0;
      for (const caracter of cuerpo) {
        if (caracter === '(') abiertos += 1;
        if (caracter === ')') abiertos -= 1;
        minimo = Math.min(minimo, abiertos);
      }
      const comillas = (cuerpo.match(/'/g) ?? []).length;
      return abiertos !== 0 || minimo < 0 || comillas % 2 !== 0;
    });

    expect(rotos).toEqual([]);
  });

  it('solo referencia columnas que existen en las migraciones anteriores', () => {
    // tenants.plan_key viene de CreateIdentitySchema y subscription_plans.key /
    // .name de CompleteSuperadminTenantList. Un SELECT de una columna inventada
    // pasa los tests con mocks y revienta en runtime: ya nos costo produccion.
    expect(SQL).toContain('REFERENCES subscription_plans(key)');
    expect(SQL).toContain('tenant.plan_key');
    expect(SQL).toContain('plan.name');
    expect(SQL).not.toMatch(/FROM (public\.)?tenants[^;]*\btenant\.name\b/s);
  });
});
