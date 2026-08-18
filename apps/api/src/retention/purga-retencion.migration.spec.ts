import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PATROL_RULES, patrolRulesSchema } from '@sentrycore/shared';

/**
 * Lo que un mock nunca va a cazar.
 *
 * Este archivo compara el TEXTO de la migracion contra lo que el servicio dice
 * consultar y contra los rangos del zod. No prueba que el SQL corra —para eso
 * esta purga-retencion.integration.spec.ts contra PostgreSQL de verdad— pero si
 * prueba que la tabla nace cerrada, que la aplicacion NO gana permiso de borrado
 * sobre la evidencia y que los pisos no se separaron de las reglas.
 *
 * Aca importa mas que en otros carriles: esto BORRA, y borra sin vuelta atras.
 */
const SELLO = '1725904800219';
const MIGRACION = readFileSync(
  join(__dirname, `../database/migrations/${SELLO}-CreateRetentionPurge.ts`),
  'utf8',
);
const SERVICIO = readFileSync(join(__dirname, 'purga-retencion.service.ts'), 'utf8');

const bloqueDeTabla = (tabla: string): string => {
  const inicio = MIGRACION.indexOf(`CREATE TABLE ${tabla} (`);
  expect(inicio).toBeGreaterThan(-1);
  const fin = MIGRACION.indexOf('`);', inicio);
  return MIGRACION.slice(inicio, fin);
};

/**
 * El min de una regla, PREGUNTANDOSELO al zod en vez de copiarlo a mano.
 *
 * Se busca por biseccion con safeParse y no leyendo `_def.checks`: los internos
 * de zod cambian entre versiones menores, y un test que se rompe al actualizar
 * una dependencia termina borrado en vez de arreglado. El default siempre es un
 * valor valido, asi que sirve de extremo alto.
 */
const minDeLaRegla = (clave: 'photoRetentionDays' | 'gpsTrackRetentionDays'): number => {
  const acepta = (valor: number): boolean =>
    patrolRulesSchema.safeParse({ [clave]: valor }).success;

  let rechaza = 0;
  let admite = DEFAULT_PATROL_RULES[clave];
  expect(acepta(admite)).toBe(true);
  expect(acepta(rechaza)).toBe(false);

  while (admite - rechaza > 1) {
    const medio = Math.floor((rechaza + admite) / 2);
    if (acepta(medio)) admite = medio;
    else rechaza = medio;
  }
  return admite;
};

describe('migracion de la purga por retencion', () => {
  it('el sello es posterior al ultimo de staging y coincide en archivo, clase y name', () => {
    // 1725818400000 es RevokePrivilegiosDeMas, la ultima aplicada en staging.
    // TypeORM ordena por la CLASE: un sello anterior haria que estas funciones
    // se creen ANTES de una migracion que ya corrio.
    expect(Number(SELLO)).toBeGreaterThan(1725818400000);
    expect(MIGRACION).toContain(`CreateRetentionPurge${SELLO}`);
    expect(MIGRACION).toContain(`name = 'CreateRetentionPurge${SELLO}'`);
  });

  it('retention_purge_runs lleva tenant_id, RLS ENABLE **y** FORCE', () => {
    expect(bloqueDeTabla('retention_purge_runs')).toContain('tenant_id uuid NOT NULL');
    expect(MIGRACION).toContain('ALTER TABLE retention_purge_runs ENABLE ROW LEVEL SECURITY');
    expect(MIGRACION).toContain('ALTER TABLE retention_purge_runs FORCE ROW LEVEL SECURITY');
  });

  it('retention_tenant_sweeps lleva tenant_id, RLS ENABLE **y** FORCE', () => {
    // La tabla que arregla el bug de rotacion es tabla de negocio como cualquier
    // otra: sin FORCE, el dueño se salta su propia politica y las migraciones y
    // el seed corren justamente como dueño.
    expect(bloqueDeTabla('retention_tenant_sweeps')).toContain('tenant_id uuid PRIMARY KEY');
    expect(MIGRACION).toContain('ALTER TABLE retention_tenant_sweeps ENABLE ROW LEVEL SECURITY');
    expect(MIGRACION).toContain('ALTER TABLE retention_tenant_sweeps FORCE ROW LEVEL SECURITY');
  });

  it('la politica falla cerrada y la escritura no puede cambiar de empresa', () => {
    for (const tabla of ['retention_purge_runs', 'retention_tenant_sweeps']) {
      const inicio = MIGRACION.indexOf(`CREATE POLICY ${tabla}_isolation`);
      expect(inicio).toBeGreaterThan(-1);
      const politica = MIGRACION.slice(inicio, inicio + 400);
      expect(politica).toContain('tenant_id = app_tenant_id()');
      expect(politica).toContain('app_has_audited_support_access(tenant_id)');
      expect(politica).toContain('WITH CHECK (tenant_id = app_tenant_id())');
    }
  });

  it('las dos tablas nuevas se leen y NO se escriben desde la aplicacion', () => {
    // El script de init deja ALTER DEFAULT PRIVILEGES con los cuatro verbos
    // sobre toda tabla nueva: sin estos REVOKE, un GRANT SELECT no acota nada.
    for (const tabla of ['retention_purge_runs', 'retention_tenant_sweeps']) {
      expect(MIGRACION).toContain(`GRANT SELECT ON ${tabla} TO sentrycore_app`);
      expect(MIGRACION).toContain(`REVOKE INSERT, UPDATE, DELETE ON ${tabla} FROM sentrycore_app`);
      expect(MIGRACION).not.toMatch(new RegExp(`GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON ${tabla}`));
    }
  });

  it('NO le da DELETE a sentrycore_app sobre ninguna tabla append-only', () => {
    // Es el corazon del carril: la purga existe justamente para no tener que
    // hacer esto. Si algun dia aparece, el libro de novedades y la evidencia
    // dejan de servir como prueba y nadie se entera hasta el juicio.
    for (const tabla of ['scan_photos', 'event_photos', 'field_events', 'audit_log']) {
      expect(MIGRACION).not.toMatch(new RegExp(`GRANT[^;]*DELETE[^;]*ON ${tabla}`));
      expect(MIGRACION).not.toMatch(new RegExp(`DELETE ON ${tabla} TO sentrycore_app`));
    }
  });

  it('no toca field_events ni audit_log de ninguna forma', () => {
    // El libro de novedades y la auditoria no se purgan por antiguedad. Que la
    // migracion ni los nombre en un DELETE es la garantia barata de eso.
    expect(MIGRACION).not.toMatch(/DELETE FROM public\.field_events/);
    expect(MIGRACION).not.toMatch(/DELETE FROM public\.audit_log/);
  });

  it('todas las funciones son SECURITY DEFINER menos la del piso', () => {
    for (const funcion of [
      'retencion_tenants',
      'retencion_marcar_barrido',
      'retencion_fotos_vencidas',
      'retencion_purgar_fotos',
      'retencion_purgar_trazas',
    ]) {
      const inicio = MIGRACION.indexOf(`CREATE FUNCTION ${funcion}(`);
      expect(inicio).toBeGreaterThan(-1);
      expect(MIGRACION.slice(inicio, inicio + 1200)).toContain('SECURITY DEFINER');
    }
  });

  it('cada funcion revoca a PUBLIC y otorga EXECUTE solo a sentrycore_app', () => {
    expect(MIGRACION).toContain('REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC');
    expect(MIGRACION).toContain('GRANT EXECUTE ON FUNCTION ${firma} TO sentrycore_app');
    for (const firma of [
      'retencion_dias_efectivos(text, integer)',
      'retencion_tenants(integer)',
      'retencion_marcar_barrido(uuid)',
      'retencion_fotos_vencidas(uuid, text, integer, integer, uuid[])',
      'retencion_purgar_fotos(uuid, text, integer, uuid[])',
      'retencion_purgar_trazas(uuid, integer, integer)',
    ]) {
      expect(MIGRACION).toContain(`'${firma}'`);
      // El down tiene que deshacer exactamente la misma firma: con un parametro
      // de mas o de menos, el DROP no encuentra nada y no avisa.
      expect(MIGRACION).toContain(`DROP FUNCTION IF EXISTS ${firma}`);
    }
  });

  it('el cerrojo de "sin contexto de tenant" esta en las tres puertas de entrada', () => {
    // retencion_tenants lo lleva en su WHERE, retencion_marcar_barrido lo lanza
    // como 42501 y el resto lo hereda de retencion_dias_efectivos.
    const lanzan = MIGRACION.match(
      /IF NULLIF\(current_setting\('app\.tenant_id', true\), ''\) IS NOT NULL THEN/g,
    );
    expect(lanzan).toHaveLength(2);
    expect(MIGRACION).toContain(
      `WHERE NULLIF(current_setting('app.tenant_id', true), '') IS NULL`,
    );
  });

  /**
   * EL BUG 1 DEL ISSUE, en el unico lugar donde se puede cazar sin base.
   *
   * `ORDER BY empresa.id LIMIT max_rows` sin nada que achique el conjunto entre
   * pasadas convierte el techo en una lista fija: con 501 empresas, la 501 no se
   * purga nunca y el log no dice nada raro.
   */
  it('retencion_tenants rota por la marca de barrido y no por el id', () => {
    const inicio = MIGRACION.indexOf('CREATE FUNCTION retencion_tenants(');
    const cuerpo = MIGRACION.slice(inicio, MIGRACION.indexOf('$$\n    `', inicio));

    expect(cuerpo).toContain('LEFT JOIN public.retention_tenant_sweeps');
    // NULLS FIRST: una empresa nueva no espera una vuelta entera.
    expect(cuerpo).toContain('ORDER BY barrido.swept_at ASC NULLS FIRST, empresa.id');
    // El id sigue estando, pero solo de desempate: si fuera la primera clave, el
    // bug vuelve entero.
    expect(cuerpo).not.toMatch(/ORDER BY\s+empresa\.id\s*\n/);
  });

  it('la marca de barrido se escribe con UPSERT y el servicio la llama', () => {
    // Sin el ON CONFLICT, la segunda pasada de cada empresa reventaria contra la
    // PK y todas quedarian marcadas con la fecha de la primera vuelta.
    expect(MIGRACION).toContain('ON CONFLICT (tenant_id) DO UPDATE SET swept_at = now()');
    expect(SERVICIO).toContain('retencion_marcar_barrido');
  });

  /**
   * EL BUG 2 DEL ISSUE. El contador inflado y el bloqueo de cabecera son el
   * mismo problema: el lote siguiente vuelve a traer la foto trabada.
   */
  it('retencion_fotos_vencidas acepta exclusiones y el servicio se las manda', () => {
    const inicio = MIGRACION.indexOf('CREATE FUNCTION retencion_fotos_vencidas(');
    const cuerpo = MIGRACION.slice(inicio, MIGRACION.indexOf('$$\n    `', inicio));

    expect(cuerpo).toContain('excluir uuid[]');
    // Dos ramas: scan_photos y event_photos. Si el filtro falta en una, esa
    // tabla vuelve a tropezarse con lo mismo lote tras lote.
    expect(cuerpo.match(/AND foto\.id <> ALL\(omitidas\)/g)).toHaveLength(2);
    // Un NULL adentro del arreglo haria que `<> ALL` devuelva NULL para todas
    // las filas y la purga se detendria en silencio.
    expect(cuerpo).toContain('WHERE excluida.elemento IS NOT NULL');

    expect(SERVICIO).toContain('$5::uuid[]');
    expect(SERVICIO).toContain('[...trabadas]');
  });

  it('los pisos de la base son los mismos min que valida el zod', () => {
    // Si alguien baja el min de photoRetentionDays a 7 y no toca la migracion,
    // el panel deja configurar 7 dias y la base sigue borrando a los 30: el
    // admin cree que cumplio y no cumplio. Y al reves es peor.
    const pisos = MIGRACION.slice(
      MIGRACION.indexOf('piso := CASE conjunto'),
      MIGRACION.indexOf('END;', MIGRACION.indexOf('piso := CASE conjunto')),
    );
    expect(pisos).toContain(`WHEN 'patrol_tracks' THEN ${minDeLaRegla('gpsTrackRetentionDays')}`);
    expect(pisos).toContain(`WHEN 'scan_photos' THEN ${minDeLaRegla('photoRetentionDays')}`);
    // Las fotos de novedades comparten piso con las de ronda: misma evidencia.
    expect(pisos).toContain(`WHEN 'event_photos' THEN ${minDeLaRegla('photoRetentionDays')}`);
  });

  it('el DELETE de fotos revalida la ventana aunque le pasen ids', () => {
    // Sin este AND, EXECUTE sobre la funcion seria una primitiva de borrado
    // arbitrario de evidencia por id.
    const bloque = MIGRACION.slice(MIGRACION.indexOf('CREATE FUNCTION retencion_purgar_fotos('));
    const ocurrencias = bloque.match(/foto\.created_at < corte/g) ?? [];
    expect(ocurrencias).toHaveLength(2);
  });

  it('el conteo sale de un CTE con RETURNING y no del rowCount del driver', () => {
    expect(MIGRACION).toContain('WITH borrado AS (');
    expect(MIGRACION).toContain('RETURNING foto.size_bytes AS bytes_fila');
  });

  it('los nombres que consulta el servicio existen en la migracion', () => {
    // La trampa que ya costo dos veces: una consulta contra una columna o una
    // funcion que no existe, con el mock devolviendo lo que el autor creia.
    for (const nombre of [
      'retencion_tenants',
      'retencion_marcar_barrido',
      'retencion_fotos_vencidas',
      'retencion_purgar_fotos',
      'retencion_purgar_trazas',
      'retention_purge_runs',
    ]) {
      expect(SERVICIO).toContain(nombre);
      expect(MIGRACION).toContain(nombre);
    }

    // Columnas de salida que el servicio lee por nombre.
    for (const columna of [
      'foto_id',
      'ruta_relativa',
      'peso_bytes',
      'filas_borradas',
      'bytes_liberados',
    ]) {
      expect(SERVICIO).toContain(columna);
      expect(MIGRACION).toContain(columna);
    }

    // Columnas de la bitacora que lee el resumen del ADMIN.
    for (const columna of [
      'retention_days',
      'cutoff',
      'rows_deleted',
      'bytes_freed',
      'executed_at',
    ]) {
      expect(SERVICIO).toContain(columna);
      expect(bloqueDeTabla('retention_purge_runs')).toContain(columna);
    }
  });

  it('crea los indices por los que barre, y el down los deshace', () => {
    expect(MIGRACION).toContain(
      'CREATE INDEX scan_photos_retention_idx ON scan_photos (tenant_id, created_at)',
    );
    expect(MIGRACION).toContain(
      'CREATE INDEX event_photos_retention_idx ON event_photos (tenant_id, created_at)',
    );
    expect(MIGRACION).toContain('DROP INDEX IF EXISTS scan_photos_retention_idx');
    expect(MIGRACION).toContain('DROP INDEX IF EXISTS event_photos_retention_idx');
    expect(MIGRACION).toContain('DROP TABLE IF EXISTS retention_purge_runs');
    expect(MIGRACION).toContain('DROP TABLE IF EXISTS retention_tenant_sweeps');
  });

  it('las dos tablas se borran con su empresa y no bloquean el purge del tenant', () => {
    // #33 aborta el borrado de un tenant si queda una sola fila con su
    // tenant_id. Sin CASCADE, estas tablas lo bloquearian para siempre.
    for (const tabla of ['retention_purge_runs', 'retention_tenant_sweeps']) {
      expect(bloqueDeTabla(tabla)).toContain(
        'FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
      );
    }
  });
});
