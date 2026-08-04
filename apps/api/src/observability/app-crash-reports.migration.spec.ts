import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que un mock no puede ver (#27).
 *
 * El aislamiento de verdad se prueba contra Postgres, pero ese test se salta
 * cuando no hay base — que es la mayoria de las corridas. Esto verifica sobre el
 * TEXTO lo que ya nos costo produccion dos veces:
 *
 *   - un SELECT de una columna que no existe: el mock devolvia la columna
 *     inventada y el test confirmaba lo que el autor ya creia;
 *   - un parentesis de mas: Postgres lo rechaza SIEMPRE, el mock nunca.
 */
const MIGRACION = readFileSync(
  join(__dirname, '../database/migrations/1725559200000-CreateAppCrashReports.ts'),
  'utf8',
);
const SERVICIO = readFileSync(join(__dirname, 'crash-reporting.service.ts'), 'utf8');

const LITERALES = (MIGRACION.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));

describe('migracion de reportes de caida', () => {
  it('la tabla lleva tenant_id y cuelga de tenants', () => {
    expect(MIGRACION).toContain('CREATE TABLE app_crash_reports');
    expect(MIGRACION).toContain('tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE');
  });

  it('hace ENABLE y ademas FORCE', () => {
    // Sin FORCE, el dueño de la tabla se salta sus propias politicas, y las
    // migraciones y el seed corren justamente como dueño.
    expect(MIGRACION).toContain('ALTER TABLE app_crash_reports ENABLE ROW LEVEL SECURITY');
    expect(MIGRACION).toContain('ALTER TABLE app_crash_reports FORCE ROW LEVEL SECURITY');
  });

  it('la politica aisla por tenant y falla cerrada', () => {
    expect(MIGRACION).toContain('tenant_id = app_tenant_id()');
    expect(MIGRACION).toContain('app_has_audited_support_access(tenant_id)');
    expect(MIGRACION).toContain('WITH CHECK (tenant_id = app_tenant_id())');
    // Nada de abrir cuando no hay contexto.
    expect(MIGRACION).not.toMatch(/USING \(\s*true\s*\)/);
    expect(MIGRACION).not.toContain('current_setting');
  });

  it('los grants estan detras del chequeo del rol de aplicacion', () => {
    expect(MIGRACION).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app')");
    expect(MIGRACION).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON app_crash_reports');
  });

  it('el timestamp es posterior al ultimo de staging', () => {
    expect(1_725_559_200_000).toBeGreaterThan(1_725_472_800_000);
    expect(MIGRACION).toContain('CreateAppCrashReports1725559200000');
  });

  it('indexa lo que consultan el resumen, el limite por usuario y la purga', () => {
    expect(MIGRACION).toContain('app_crash_reports (tenant_id, received_at DESC)');
    expect(MIGRACION).toContain('app_crash_reports (tenant_id, user_id, received_at DESC)');
  });

  it('se puede revertir', () => {
    expect(MIGRACION).toContain('DROP TABLE app_crash_reports');
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

  /**
   * El error caro: `SELECT name FROM tenants`, una columna que no existe. Aca
   * se comprueba contra la MIGRACION, no contra el mock del test.
   */
  it('el servicio no escribe ninguna columna que la tabla no defina', () => {
    const insert = /INSERT INTO app_crash_reports \(([^)]*)\)/s.exec(SERVICIO);
    expect(insert).not.toBeNull();

    const columnas = (insert?.[1] ?? '')
      .split(',')
      .map((columna) => columna.trim())
      .filter((columna) => columna.length > 0);

    expect(columnas.length).toBeGreaterThan(5);
    for (const columna of columnas) {
      expect(MIGRACION).toMatch(new RegExp(`^\\s*${columna} `, 'm'));
    }
  });

  it('el servicio no lee ninguna columna que la tabla no defina', () => {
    const leidas = [
      'app_version',
      'device_model',
      'android_version',
      'fingerprint',
      'error_name',
      'error_message',
      'fatal',
      'received_at',
      'forwarded',
      'user_id',
      'tenant_id',
    ];

    for (const columna of leidas) {
      expect(SERVICIO).toContain(columna);
      expect(MIGRACION).toMatch(new RegExp(`^\\s*${columna} `, 'm'));
    }
  });

  it('el servicio no usa `name` de tenants ni ninguna columna inventada de otra tabla', () => {
    // No hay JOIN a users ni a tenants a proposito: el nombre de una persona no
    // entra a este modulo por ningun camino.
    expect(SERVICIO).not.toMatch(/JOIN\s+users/i);
    expect(SERVICIO).not.toMatch(/FROM\s+tenants/i);
    expect(SERVICIO).not.toMatch(/full_name|display_name/);
  });
});
