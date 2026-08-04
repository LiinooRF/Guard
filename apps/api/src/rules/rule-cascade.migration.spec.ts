import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El aislamiento de verdad se prueba contra Postgres en
 * tenant-isolation.integration.spec.ts — pero ese test se salta cuando no hay
 * base, que es la mayoria de las corridas. Esto verifica sobre el texto de la
 * migracion lo que no se puede dejar al olvido: ENABLE **y** FORCE, politica que
 * falla cerrada, y que el nivel plataforma (la unica tabla sin tenant_id) no se
 * pueda escribir con un UPDATE suelto del rol de aplicacion.
 */
const SQL = readFileSync(
  join(__dirname, '../database/migrations/1725375600000-CreateRuleCascade.ts'),
  'utf8',
);

describe('migracion de la cascada de reglas', () => {
  it.each(['site_rules', 'checkpoint_rules'])('%s lleva tenant_id y entra al bucle de RLS', (tabla) => {
    expect(SQL).toContain(`CREATE TABLE ${tabla}`);
    expect(SQL).toContain('tenant_id uuid NOT NULL');
    // Las dos tablas se recorren en el mismo bucle, que hace ENABLE + FORCE +
    // politica: lo que hay que verificar es que ninguna quede fuera de la lista.
    expect(SQL).toMatch(new RegExp(`const TENANT_TABLES[^;]*'${tabla}'`, 's'));
  });

  it('el bucle de RLS hace ENABLE y ademas FORCE', () => {
    expect(SQL).toContain('ENABLE ROW LEVEL SECURITY');
    expect(SQL).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('la politica aisla por tenant y la escritura no puede cambiar de empresa', () => {
    expect(SQL).toContain('tenant_id = app_tenant_id()');
    expect(SQL).toContain('app_has_audited_support_access(tenant_id)');
    expect(SQL).toContain('WITH CHECK (tenant_id = app_tenant_id())');
  });

  it('las dos tablas cuelgan del recinto y del punto con FK compuesto por tenant', () => {
    expect(SQL).toContain('REFERENCES sites(tenant_id, id) ON DELETE CASCADE');
    expect(SQL).toContain('REFERENCES checkpoints(tenant_id, id) ON DELETE CASCADE');
  });

  it('platform_rules solo se lee desde la aplicacion; se escribe por la funcion', () => {
    expect(SQL).toContain('GRANT SELECT ON platform_rules TO voxia_app');
    expect(SQL).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON platform_rules/);
    expect(SQL).toContain('PERFORM public.assert_platform_superadmin(actor_id)');
    expect(SQL).toContain('SECURITY DEFINER');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION platform_set_rules(uuid, jsonb) FROM PUBLIC');
  });

  it('los grants estan detras del chequeo del rol de aplicacion', () => {
    expect(SQL).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app')");
  });

  it('se puede revertir', () => {
    for (const sentencia of [
      'DROP TABLE checkpoint_rules',
      'DROP TABLE site_rules',
      'DROP FUNCTION platform_set_rules(uuid, jsonb)',
      'DROP TABLE platform_rules',
    ]) {
      expect(SQL).toContain(sentencia);
    }
  });
});
