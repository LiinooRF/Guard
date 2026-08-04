import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El SQL del barrido, revisado sobre el TEXTO de la migracion.
 *
 * El aislamiento de verdad se prueba contra Postgres en
 * tenant-isolation.integration.spec.ts (que descubre solas las tablas con
 * tenant_id, asi que report_dispatch_attempts entra sin tocar nada), pero ese
 * test se salta cuando no hay base, que es la mayoria de las corridas. Esto
 * verifica lo que no se puede dejar al olvido, con el mismo criterio que
 * feature-flags.migration.spec.ts y rule-cascade.migration.spec.ts:
 *
 *   - parentesis y comillas balanceados en cada sentencia. Un parentesis de mas
 *     lo rechaza Postgres SIEMPRE y ningun mock lo ve;
 *   - la tabla nueva lleva tenant_id, ENABLE **y** FORCE, politica que falla
 *     cerrada, y sin UPDATE ni DELETE para el rol de aplicacion (el script de
 *     init deja ALTER DEFAULT PRIVILEGES con los cuatro verbos, asi que sin el
 *     REVOKE el GRANT no restringe nada);
 *   - la funcion cruza-tenants es SECURITY DEFINER con search_path fijo, sin
 *     EXECUTE para PUBLIC, y solo se puede usar SIN contexto de tenant;
 *   - el backlog descuenta lo ya entregado **y** lo ya atendido. Ese segundo
 *     NOT EXISTS es la diferencia entre un barrido que avanza y uno que se
 *     queda masticando las mismas rondas hasta que se vence la ventana.
 */
const RUTA = join(
  __dirname,
  '../database/migrations/1725472900000-CreateReportDispatchBacklog.ts',
);
const SQL = readFileSync(RUTA, 'utf8');

/** Los literales de plantilla del archivo, que es donde vive el SQL. */
const LITERALES = (SQL.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));

describe('migracion del backlog de despachos', () => {
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

  describe('report_dispatch_attempts', () => {
    it('lleva tenant_id y cuelga de la ronda', () => {
      expect(SQL).toContain('CREATE TABLE report_dispatch_attempts');
      expect(SQL).toContain('tenant_id uuid NOT NULL');
      expect(SQL).toContain('PRIMARY KEY (tenant_id, patrol_id)');
      // La ronda que se borra se lleva su marca: si no, quedaria una fila
      // huerfana que nadie puede explicar.
      expect(SQL).toContain('REFERENCES patrols(tenant_id, id) ON DELETE CASCADE');
    });

    it('hace ENABLE y ademas FORCE, y la politica falla cerrada', () => {
      expect(SQL).toContain('ALTER TABLE report_dispatch_attempts ENABLE ROW LEVEL SECURITY');
      expect(SQL).toContain('ALTER TABLE report_dispatch_attempts FORCE ROW LEVEL SECURITY');
      expect(SQL).toContain('CREATE POLICY report_dispatch_attempts_isolation');
      expect(SQL).toContain('tenant_id = app_tenant_id()');
      expect(SQL).toContain('app_has_audited_support_access(tenant_id)');
      expect(SQL).toContain('WITH CHECK (tenant_id = app_tenant_id())');
    });

    it('es bitacora: el rol de aplicacion inserta y lee, no corrige ni borra', () => {
      expect(SQL).toContain('GRANT SELECT, INSERT ON report_dispatch_attempts TO voxia_app');
      expect(SQL).toContain('REVOKE UPDATE, DELETE ON report_dispatch_attempts FROM voxia_app');
      expect(SQL).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app')");
    });

    it('solo admite los dos motivos que el despacho sabe escribir', () => {
      // Los mismos de MotivoAtendido en envio-informe.service.ts. Si alguien
      // agrega un motivo alla y no aca, el INSERT revienta en produccion.
      expect(SQL).toContain("CHECK (reason IN ('envio_desactivado', 'sin_destinatarios'))");
    });
  });

  describe('report_dispatch_backlog', () => {
    it('se salta RLS como corresponde y con el camino de busqueda fijo', () => {
      expect(SQL).toContain('SECURITY DEFINER');
      expect(SQL).toContain('SET search_path = pg_catalog, public');
    });

    it('no la puede ejecutar cualquiera', () => {
      expect(SQL).toContain(
        'REVOKE ALL ON FUNCTION report_dispatch_backlog(integer, integer, integer) FROM PUBLIC',
      );
      expect(SQL).toContain(
        'GRANT EXECUTE ON FUNCTION report_dispatch_backlog(integer, integer, integer) TO voxia_app',
      );
    });

    it('solo sirve SIN contexto de tenant', () => {
      // El unico cerrojo que el worker puede cumplir: no tiene rol ni usuario.
      // Cualquier request si setea app.tenant_id, y entonces la funcion no
      // devuelve nada. Es la misma forma de "fallar cerrado" que usan las
      // politicas de RLS.
      expect(SQL).toContain("NULLIF(current_setting('app.tenant_id', true), '') IS NULL");
    });

    it('devuelve identificadores y nada mas', () => {
      expect(SQL).toContain('RETURNS TABLE (tenant_id uuid, patrol_id uuid)');
      expect(SQL).toContain('SELECT patrol.tenant_id, patrol.id');
      // tenants NO tiene columna `name` (tiene slug, legal_name y display_name):
      // ese SELECT inventado ya costo produccion una vez.
      expect(SQL).not.toMatch(/\btenant\.name\b/);
    });

    it('descuenta lo ya entregado Y lo ya atendido', () => {
      expect(SQL).toContain('FROM public.report_deliveries delivery');
      expect(SQL).toContain('FROM public.report_dispatch_attempts attempt');
      expect((SQL.match(/AND NOT EXISTS \(/g) ?? []).length).toBe(2);
    });

    it('empieza por las perdidas frescas, que son las que todavia sirven', () => {
      // Con max_rows de techo, lo que quede fuera del corte espera. Si el corte
      // empezara por las mas viejas, un lote de rondas atrasadas dejaria afuera
      // justo a la que se perdio recien.
      expect(SQL).toContain('ORDER BY patrol.closed_at DESC');
    });

    it('solo mira rondas cerradas de empresas vigentes', () => {
      expect(SQL).toContain("patrol.status IN ('completada', 'incompleta', 'vencida')");
      expect(SQL).toContain("tenant.status = 'active'");
      expect(SQL).toContain('patrol.closed_at IS NOT NULL');
    });
  });

  it('se puede revertir', () => {
    for (const sentencia of [
      'DROP FUNCTION IF EXISTS report_dispatch_backlog(integer, integer, integer)',
      'DROP INDEX IF EXISTS patrols_closed_at_idx',
      'DROP TABLE IF EXISTS report_dispatch_attempts',
    ]) {
      expect(SQL).toContain(sentencia);
    }
  });
});
