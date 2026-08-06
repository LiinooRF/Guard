import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El SQL del aviso de inicio, revisado sobre el TEXTO de la migracion (#43).
 *
 * Mismo criterio que envio-informe.backlog.migration.spec.ts: el aislamiento de
 * verdad se prueba contra Postgres en tenant-isolation.integration.spec.ts, pero
 * ese test se salta cuando no hay base —la mayoria de las corridas—, y una
 * funcion cruza-tenants mal escrita no la ve ningun mock. Aca se verifica lo que
 * no se puede dejar al olvido:
 *
 *   - parentesis y comillas balanceados: un parentesis de mas lo rechaza
 *     PostgreSQL SIEMPRE y ningun mock lo ve;
 *   - la funcion es SECURITY DEFINER con search_path fijo, sin EXECUTE para
 *     PUBLIC, y solo se puede usar SIN contexto de tenant;
 *   - devuelve SOLO identificadores. Una funcion que se salta RLS y ademas
 *     devuelve datos de negocio es una puerta trasera;
 *   - la empresa suspendida no recibe avisos, y la ronda cuya hora ya paso
 *     tampoco: eso ya no es "por comenzar", es atrasada, y de eso avisa
 *     alertas-ronda al supervisor.
 */
const RUTA = join(
  __dirname,
  '../database/migrations/1725998400000-CreatePatrolStartNoticeBacklog.ts',
);
const SQL = readFileSync(RUTA, 'utf8');

/** Los literales de plantilla del archivo, que es donde vive el SQL. */
const LITERALES = (SQL.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));

/**
 * Solo el SQL, sin los comentarios. Las comprobaciones de "esto NO aparece" van
 * contra esto y no contra el archivo entero: si no, el propio comentario que
 * explica por que algo no esta haria fallar el test.
 */
const CUERPO = LITERALES.join('\n');

describe('migracion del backlog de avisos de inicio (#43)', () => {
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

  it('no crea ninguna tabla: la idempotencia ya vive en el jobId de la cola', () => {
    // Una bitacora "a esta ronda ya se le aviso" seria una segunda fuente de
    // verdad para lo mismo, con su RLS, sus privilegios y su purga.
    expect(CUERPO).not.toContain('CREATE TABLE');
  });

  describe('patrol_start_notice_backlog', () => {
    it('es SECURITY DEFINER con search_path fijo', () => {
      expect(SQL).toContain('CREATE FUNCTION patrol_start_notice_backlog');
      expect(SQL).toContain('SECURITY DEFINER');
      // Sin search_path fijo, una funcion SECURITY DEFINER se puede secuestrar
      // creando objetos en un esquema anterior del path.
      expect(SQL).toContain('SET search_path = pg_catalog, public');
      expect(SQL).toContain('STABLE');
    });

    it('solo se puede usar SIN contexto de tenant', () => {
      // Es el unico cerrojo que el worker puede cumplir (no tiene rol ni
      // usuario) y cierra la funcion para cualquier request, que siempre setea
      // app.tenant_id. Sin el, cualquier sesion podria enumerar pares
      // (tenant_id, patrol_id) de todas las empresas.
      expect(SQL).toContain(`NULLIF(current_setting('app.tenant_id', true), '') IS NULL`);
    });

    it('devuelve dos UUID y nada mas', () => {
      expect(SQL).toContain('RETURNS TABLE (tenant_id uuid, patrol_id uuid)');
      expect(SQL).toContain('SELECT patrol.tenant_id, patrol.id');
      // Ni el nombre del recinto, ni el del guardia, ni la hora: todo eso lo lee
      // el barrido despues, dentro de la transaccion de esa empresa.
      expect(CUERPO).not.toContain('site.name');
      expect(CUERPO).not.toContain('public.users');
      expect(CUERPO).not.toContain('guard_id');
    });

    it('nadie por defecto, EXECUTE explicito para el rol de la aplicacion', () => {
      expect(SQL).toContain(
        'REVOKE ALL ON FUNCTION patrol_start_notice_backlog(integer, integer) FROM PUBLIC',
      );
      expect(SQL).toContain(
        'GRANT EXECUTE ON FUNCTION patrol_start_notice_backlog(integer, integer) TO voxia_app',
      );
      expect(SQL).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app')");
    });

    it('filtra por lo que hace que una ronda este POR comenzar', () => {
      expect(SQL).toContain("patrol.status = 'pendiente'");
      // Ya paso su hora = atrasada, no "por comenzar". Sin esto el guardia
      // recibiria el aviso media hora despues de la hora.
      expect(SQL).toContain('patrol.scheduled_start_at > now()');
      expect(SQL).toContain('make_interval(mins => max_lead_minutes)');
      // La voluntaria es cobertura extra que el guardia decidio hacer.
      expect(SQL).toContain('NOT patrol.is_voluntary');
      // A la empresa suspendida se le corto el servicio: no se le sigue
      // empujando trabajo al telefono de sus guardias.
      expect(SQL).toContain("tenant.status = 'active'");
    });

    it('ordena por la que empieza antes y acota la pasada', () => {
      // Lo que queda fuera del techo espera dos minutos; la ronda que empieza
      // antes es la que primero deja de poder avisarse.
      expect(CUERPO).toContain('ORDER BY patrol.scheduled_start_at');
      expect(CUERPO).not.toContain('ORDER BY patrol.scheduled_start_at DESC');
      expect(CUERPO).toContain('LIMIT max_rows');
    });

    it('deja el indice que sostiene el barrido cruza-empresas', () => {
      // patrols_schedule_idx empieza por tenant_id: no sirve para un barrido sin
      // tenant, que haria un recorrido completo de patrols cada dos minutos.
      expect(SQL).toContain('CREATE INDEX patrols_inicio_pendiente_idx');
      expect(SQL).toContain("WHERE status = 'pendiente'");
    });

    it('el down deshace los dos objetos', () => {
      expect(SQL).toContain(
        'DROP FUNCTION IF EXISTS patrol_start_notice_backlog(integer, integer)',
      );
      expect(SQL).toContain('DROP INDEX IF EXISTS patrols_inicio_pendiente_idx');
    });
  });
});
