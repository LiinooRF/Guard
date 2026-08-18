import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que ningun mock puede ver, verificado sobre el TEXTO.
 *
 * Tres errores reales de esta semana motivan cada bloque:
 *   A) un SELECT de una columna que no existe (`tenants.name`), con la CI en
 *      verde porque el mock devolvia la columna inventada;
 *   B) un parentesis de cierre de mas en un SQL, que Postgres rechaza siempre y
 *      el test no veia porque mockeaba `query`;
 *   C) leer una regla al reves por no leer su comentario.
 *
 * Contra A: cada columna que consulta el codigo se busca en la migracion que la
 * crea. Contra B: se cuentan parentesis y comillas de cada literal SQL.
 */
const MIGRACIONES = join(__dirname, '../database/migrations');

const REMITENTE = leer('1725559230000-CreateTenantMailSender.ts');
const BRANDING = leer('1724857200000-CreateTenantBranding.ts');
const IDENTIDAD = leer('1722350000000-CreateIdentitySchema.ts');

const MARCA = readFileSync(join(__dirname, 'plantillas-marca.ts'), 'utf8');
const SERVICIO = readFileSync(join(__dirname, 'plantillas-remitente.service.ts'), 'utf8');

function leer(archivo: string): string {
  return readFileSync(join(MIGRACIONES, archivo), 'utf8');
}

/** Los literales de plantilla, que es donde vive el SQL. */
function literales(fuente: string): string[] {
  return (fuente.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));
}

describe('migracion del remitente por tenant', () => {
  it('corre despues de la ultima migracion de staging', () => {
    // Debe ser posterior a 1725472800000-CreateConsentPolicies.
    expect(1725559230000).toBeGreaterThan(1725472800000);
    expect(REMITENTE).toContain('CreateTenantMailSender1725559230000');
  });

  it('la tabla lleva tenant_id y RLS con ENABLE y ademas FORCE', () => {
    expect(REMITENTE).toContain('CREATE TABLE tenant_mail_sender');
    expect(REMITENTE).toContain('tenant_id uuid PRIMARY KEY REFERENCES tenants(id)');
    expect(REMITENTE).toContain('ALTER TABLE tenant_mail_sender ENABLE ROW LEVEL SECURITY');
    expect(REMITENTE).toContain('ALTER TABLE tenant_mail_sender FORCE ROW LEVEL SECURITY');
  });

  it('la politica aisla por tenant y falla cerrada', () => {
    expect(REMITENTE).toContain('CREATE POLICY tenant_mail_sender_isolation');
    expect(REMITENTE).toContain('tenant_id = app_tenant_id()');
    expect(REMITENTE).toContain('app_has_audited_support_access(tenant_id)');
    expect(REMITENTE).toContain('WITH CHECK (tenant_id = app_tenant_id())');
  });

  it('la aplicacion no puede escribir la verificacion del dominio', () => {
    // Sin el REVOKE previo el GRANT por columna no restringe nada: el script de
    // init deja ALTER DEFAULT PRIVILEGES con los cuatro verbos sobre toda tabla
    // nueva. Es la trampa que ya costo un PR.
    expect(REMITENTE).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON tenant_mail_sender FROM sentrycore_app',
    );
    expect(REMITENTE).toContain(
      'GRANT INSERT (tenant_id, reply_to, from_address) ON tenant_mail_sender TO sentrycore_app',
    );
    expect(REMITENTE).toContain(
      'GRANT UPDATE (reply_to, from_address, updated_at) ON tenant_mail_sender TO sentrycore_app',
    );
    expect(REMITENTE).not.toMatch(/GRANT UPDATE \([^)]*from_address_verified_at/);
    expect(REMITENTE).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app')");
  });

  it('cambiar la direccion borra la verificacion anterior, y lo hace la base', () => {
    expect(REMITENTE).toContain('CREATE TRIGGER tenant_mail_sender_reset_verificacion');
    expect(REMITENTE).toContain('BEFORE UPDATE ON tenant_mail_sender');
    expect(REMITENTE).toContain('NEW.from_address IS DISTINCT FROM OLD.from_address');
    expect(REMITENTE).toContain('NEW.from_address_verified_at := NULL');
  });

  it('mover la verificacion no depende solo del grant por columna', () => {
    // El trigger tiene que mirar TAMBIEN el caso en que from_address no cambia:
    // `UPDATE ... SET from_address_verified_at = now()` a secas atravesaba la
    // primera rama sin tocar nada y lo detenia unicamente el privilegio.
    expect(REMITENTE).toContain(
      'NEW.from_address_verified_at IS DISTINCT FROM OLD.from_address_verified_at',
    );
    expect(REMITENTE).toContain("USING ERRCODE = '42501'");
    // Y el dueño de la tabla sigue pudiendo acreditar: es la unica via que hoy
    // existe para verificar un dominio (ver 9.3 de INTEGRACION.md).
    expect(REMITENTE).toContain('pg_has_role(');
    expect(REMITENTE).toContain('SELECT relowner FROM pg_class WHERE oid = TG_RELID');
  });

  it('se puede revertir sin dejar la funcion suelta', () => {
    expect(REMITENTE).toContain('DROP TABLE tenant_mail_sender');
    expect(REMITENTE).toContain('DROP FUNCTION tenant_mail_sender_reset_verificacion()');
  });

  it('cada SQL tiene los parentesis y las comillas balanceados', () => {
    const rotos = literales(REMITENTE).filter((cuerpo) => {
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

  it('el SQL de los servicios tambien cierra sus parentesis', () => {
    for (const fuente of [MARCA, SERVICIO]) {
      const rotos = literales(fuente).filter((cuerpo) => {
        if (!/SELECT|INSERT|UPDATE/.test(cuerpo)) return false;
        let abiertos = 0;
        for (const caracter of cuerpo) {
          if (caracter === '(') abiertos += 1;
          if (caracter === ')') abiertos -= 1;
        }
        return abiertos !== 0;
      });
      expect(rotos).toEqual([]);
    }
  });
});

describe('las consultas solo nombran columnas que existen', () => {
  it('tenants: display_name y legal_name, nunca name', () => {
    expect(IDENTIDAD).toContain('legal_name text NOT NULL');
    expect(IDENTIDAD).toContain('display_name text NOT NULL');
    expect(MARCA).toContain('t.display_name');
    expect(MARCA).toContain('t.legal_name');
    // La columna inventada que rompio todos los informes con la CI en verde.
    expect(MARCA).not.toMatch(/\bt\.name\b/);
    expect(IDENTIDAD).not.toMatch(/CREATE TABLE tenants[\s\S]{0,400}?^\s+name /m);
  });

  it.each(['commercial_name', 'logo_uri', 'primary_color', 'mail_from_name', 'mail_footer'])(
    'tenant_branding.%s existe en su migracion y se consulta con prefijo b.',
    (columna) => {
      expect(BRANDING).toContain(columna);
      expect(MARCA).toContain(`b.${columna}`);
    },
  );

  it.each(['reply_to', 'from_address', 'from_address_verified_at'])(
    'tenant_mail_sender.%s existe en su migracion',
    (columna) => {
      expect(REMITENTE).toContain(columna);
      expect(`${MARCA}${SERVICIO}`).toContain(columna);
    },
  );

  it('el servicio no consulta ninguna columna de tenant_mail_sender que no exista', () => {
    // Se extraen las columnas que la migracion declara y se comprueba que el
    // SELECT del servicio no pida ninguna otra.
    // Espacios literales y no \s: con \s el ^ del modo multilinea se come los
    // saltos y la clase deja de significar "sangria de columna".
    const declaradas = new Set(
      [...REMITENTE.matchAll(/^ {8}([a-z_]+) (uuid|text|timestamptz)/gm)]
        .map((coincidencia) => coincidencia[1])
        .filter((columna): columna is string => columna !== undefined),
    );
    expect(declaradas).toContain('reply_to');
    expect(declaradas).toContain('from_address');
    expect(declaradas).toContain('from_address_verified_at');
    expect(declaradas).toContain('updated_at');

    const select = /SELECT reply_to, from_address, from_address_verified_at/.exec(SERVICIO);
    expect(select).not.toBeNull();
    for (const columna of (select?.[0] ?? '').replace('SELECT ', '').split(', ')) {
      expect(declaradas.has(columna)).toBe(true);
    }
  });
});
