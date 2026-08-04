import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que un mock nunca va a cazar.
 *
 * Ya nos costo dos veces: un SELECT de una columna que no existe (el mock
 * devolvia la columna inventada, asi que el test confirmaba lo que el autor ya
 * creia) y RLS a medias. Este archivo compara el TEXTO de la migracion contra el
 * TEXTO del servicio. No prueba que la consulta corra —para eso esta el humo
 * e2e— pero si prueba que los nombres coinciden y que la tabla nace cerrada.
 */
const MIGRACION = readFileSync(
  join(__dirname, '../database/migrations/1725559210000-CreateConfigChangeLog.ts'),
  'utf8',
);
const SERVICIO = readFileSync(join(__dirname, 'config-audit.service.ts'), 'utf8');

/** Columnas que el servicio nombra en su SELECT del historial del tenant. */
const COLUMNAS_QUE_LEE = [
  'id',
  'tenant_id',
  'area',
  'scope',
  'target_id',
  'param_key',
  'old_value',
  'new_value',
  'actor_id',
  'actor_label',
  'support_access_id',
  'changed_at',
];

const bloqueDeTabla = (tabla: string): string => {
  const inicio = MIGRACION.indexOf(`CREATE TABLE ${tabla} (`);
  expect(inicio).toBeGreaterThan(-1);
  const fin = MIGRACION.indexOf('`);', inicio);
  return MIGRACION.slice(inicio, fin);
};

describe('migracion de la auditoria de configuracion', () => {
  it('la migracion es posterior a la ultima de staging', () => {
    expect(Number('1725559210000')).toBeGreaterThan(1725472800000);
    expect(MIGRACION).toContain('CreateConfigChangeLog1725559210000');
  });

  it('config_change_log lleva tenant_id, RLS ENABLE **y** FORCE', () => {
    expect(MIGRACION).toContain('CREATE TABLE config_change_log');
    expect(bloqueDeTabla('config_change_log')).toContain('tenant_id uuid NOT NULL');
    expect(MIGRACION).toContain('ALTER TABLE config_change_log ENABLE ROW LEVEL SECURITY');
    expect(MIGRACION).toContain('ALTER TABLE config_change_log FORCE ROW LEVEL SECURITY');
  });

  it('la politica falla cerrada y la escritura no puede cambiar de empresa', () => {
    expect(MIGRACION).toContain('tenant_id = app_tenant_id()');
    expect(MIGRACION).toContain('app_has_audited_support_access(tenant_id)');
    expect(MIGRACION).toContain('WITH CHECK (tenant_id = app_tenant_id())');
  });

  it('la aplicacion puede leer el historial pero no escribirlo ni corregirlo', () => {
    expect(MIGRACION).toContain('GRANT SELECT ON config_change_log TO voxia_app');
    // El REVOKE es obligatorio: el script de init deja ALTER DEFAULT PRIVILEGES
    // con los cuatro verbos, asi que la tabla nace escribible.
    expect(MIGRACION).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON config_change_log FROM voxia_app',
    );
    expect(MIGRACION).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON config_change_log/);
  });

  it('el historial de plataforma no se lee ni con SELECT directo', () => {
    expect(MIGRACION).toContain('REVOKE ALL ON platform_config_change_log FROM voxia_app');
    expect(MIGRACION).not.toMatch(/GRANT[^;]*ON platform_config_change_log TO voxia_app/);
    expect(MIGRACION).toContain('PERFORM public.assert_platform_superadmin(p_actor_id)');
  });

  it('todas las tablas de configuracion tienen su trigger', () => {
    for (const tabla of [
      'tenant_rules',
      'site_rules',
      'checkpoint_rules',
      'tenant_feature_preferences',
      'tenant_feature_grants',
      'platform_rules',
      'plan_feature_flags',
    ]) {
      expect(MIGRACION).toContain(`ON ${tabla}\n      FOR EACH ROW`);
    }
  });

  it('los triggers NO cuelgan del DELETE', () => {
    // Un DELETE aca solo ocurre en cascada, cuando ya desaparecio el recinto, el
    // punto o la empresa. Auditarlo meteria escrituras dentro del borrado de un
    // tenant y lo haria fallar.
    expect(MIGRACION).toContain('AFTER INSERT OR UPDATE ON');
    expect(MIGRACION).not.toContain('OR DELETE ON');
  });

  it('el nombre de columna que lee el servicio existe en la migracion', () => {
    const bloque = bloqueDeTabla('config_change_log');
    for (const columna of COLUMNAS_QUE_LEE) {
      expect(bloque).toContain(`${columna} `);
      expect(SERVICIO).toContain(columna);
    }
  });

  it('el servicio no inventa columnas que la tabla no tiene', () => {
    const bloque = bloqueDeTabla('config_change_log');
    const referenciadas = [...SERVICIO.matchAll(/cambio\.([a-z_]+)/g)].map((m) => m[1]);
    expect(referenciadas.length).toBeGreaterThan(0);
    for (const columna of new Set(referenciadas)) {
      expect(bloque).toContain(`${columna} `);
    }
  });

  it('las columnas de otras tablas que se leen existen donde corresponde', () => {
    // sites.name, sites.timezone y checkpoints.name se verifican contra su
    // propia migracion, no contra el mock del test.
    const demo = readFileSync(
      join(__dirname, '../database/migrations/1722524400000-CreateDemoDomain.ts'),
      'utf8',
    );
    expect(demo).toContain('timezone text NOT NULL');
    expect(demo).toContain('CREATE TABLE sites');
    expect(demo).toContain('CREATE TABLE checkpoints');
    // El trigger arma la etiqueta del actor con estas dos, y no con un 'name'
    // que en users no existe.
    const identidad = readFileSync(
      join(__dirname, '../database/migrations/1722350000000-CreateIdentitySchema.ts'),
      'utf8',
    );
    expect(identidad).toContain('given_name text NOT NULL');
    expect(identidad).toContain('family_name text NOT NULL');
    expect(MIGRACION).toContain('persona.given_name');
    expect(MIGRACION).toContain('persona.family_name');
  });

  it('se puede revertir: triggers, funciones y tablas', () => {
    for (const sentencia of [
      'DROP TRIGGER ${trigger} ON ${tabla}',
      'DROP FUNCTION app_log_platform_config_change()',
      'DROP FUNCTION app_log_config_change()',
      'DROP TABLE platform_config_change_log',
      'DROP TABLE config_change_log',
    ]) {
      expect(MIGRACION).toContain(sentencia);
    }
  });
});
