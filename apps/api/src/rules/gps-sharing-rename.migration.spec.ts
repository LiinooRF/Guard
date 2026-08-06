import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_PATROL_RULES,
  isRuleAllowedAtScope,
  patrolRulesSchema,
  PATROL_RULE_CATALOG,
  PATROL_RULE_KEYS,
} from '@voxia/shared';

/**
 * El renombre `gpsSharingRequired` -> `gpsSharingMandatory` toca TRES capas: el
 * contrato (rules.ts), el codigo que lo lee (api + web) y el DATO ya guardado en
 * las filas de `*_rules`. Aplicar una sin las otras no da error de compilacion
 * en produccion: da empresas con GPS opcional que amanecen en obligatorio y
 * guardias que no pueden iniciar la ronda.
 *
 * Este archivo amarra las dos mitades que un test normal no mira:
 *   1. Que el catalogo quedo con el nombre nuevo y sin huerfanos.
 *   2. Que la migracion de datos hace lo que su encabezado promete.
 *
 * La segunda mitad se prueba sobre el TEXTO de la migracion, igual que
 * rule-cascade.migration.spec.ts: el aislamiento y el SQL de verdad se prueban
 * contra PostgreSQL en los tests de integracion, que se saltan cuando no hay
 * base — o sea en la mayoria de las corridas, que es justo cuando esto se
 * escapa.
 */

const RAIZ_API = join(__dirname, '..');
const RUTA_MIGRACION = join(
  RAIZ_API,
  'database/migrations/1725994800000-RenameGpsSharingMandatory.ts',
);
const SQL = readFileSync(RUTA_MIGRACION, 'utf8');

const CLAVE_VIEJA = 'gpsSharingRequired';
const CLAVE_NUEVA = 'gpsSharingMandatory';

const TABLAS_CON_RLS = ['tenant_rules', 'site_rules', 'checkpoint_rules'];
const TABLAS_TODAS = ['platform_rules', ...TABLAS_CON_RLS];

/**
 * Unicos archivos de apps/api que pueden seguir nombrando la clave vieja, y por
 * que. Cualquier otro es un renombre a medias: el codigo leeria una clave que ya
 * no existe en el schema y `sanitizeOverrides()` la descarta EN SILENCIO.
 */
const MENCIONES_HISTORICAS_PERMITIDAS = new Set([
  // La migracion del renombre: la clave vieja es su dato de entrada.
  'database/migrations/1725994800000-RenameGpsSharingMandatory.ts',
  // Encabezado de una migracion ya aplicada que cuenta como se llamaba entonces.
  'database/migrations/1725462010000-CreateGpsEnforcement.ts',
  // Este mismo archivo.
  'rules/gps-sharing-rename.migration.spec.ts',
  // El mismo renombre contra PostgreSQL de verdad: la clave vieja es lo que
  // siembra para comprobar que la migracion la mueve.
  'rules/gps-sharing-rename.integration.spec.ts',
]);

function archivosTs(directorio: string, prefijo = ''): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(directorio)) {
    if (entrada === 'node_modules' || entrada === 'dist') continue;
    const absoluto = join(directorio, entrada);
    const relativo = prefijo ? `${prefijo}/${entrada}` : entrada;
    if (statSync(absoluto).isDirectory()) salida.push(...archivosTs(absoluto, relativo));
    else if (entrada.endsWith('.ts')) salida.push(relativo);
  }
  return salida;
}

describe('renombre de la regla de GPS: el contrato', () => {
  it('el catalogo declara la clave nueva y no queda ninguna huerfana', () => {
    expect(PATROL_RULE_CATALOG[CLAVE_NUEVA]).toBeDefined();
    expect(PATROL_RULE_KEYS).toContain(CLAVE_NUEVA);
    expect(PATROL_RULE_KEYS as readonly string[]).not.toContain(CLAVE_VIEJA);
    expect(Object.keys(DEFAULT_PATROL_RULES)).not.toContain(CLAVE_VIEJA);
    expect(Object.keys(patrolRulesSchema.shape)).not.toContain(CLAVE_VIEJA);
  });

  it('el renombre no cambia el comportamiento: mismo default y mismos niveles', () => {
    // Si el default cambiara, el renombre dejaria de ser un renombre y le
    // moveria la regla a todas las empresas que la heredan.
    expect(DEFAULT_PATROL_RULES[CLAVE_NUEVA]).toBe(true);
    expect(PATROL_RULE_CATALOG[CLAVE_NUEVA].type).toBe('boolean');
    // HASTA_RECINTO, igual que antes: plataforma / empresa / recinto, y NO punto.
    expect(isRuleAllowedAtScope(CLAVE_NUEVA, 'platform')).toBe(true);
    expect(isRuleAllowedAtScope(CLAVE_NUEVA, 'tenant')).toBe(true);
    expect(isRuleAllowedAtScope(CLAVE_NUEVA, 'site')).toBe(true);
    expect(isRuleAllowedAtScope(CLAVE_NUEVA, 'checkpoint')).toBe(false);
  });

  it('la ficha explica obligatorio vs OPCIONAL, no encendido vs apagado', () => {
    // El texto que ve el admin es lo unico que lee antes de mover el
    // interruptor; tres personas leyeron esta regla como interruptor.
    const descripcion = PATROL_RULE_CATALOG[CLAVE_NUEVA].description.toLowerCase();
    expect(descripcion).toContain('opcional');
    // Y sigue valiendo la regla del catalogo: nada de nombres de campo en el
    // texto del cliente (rule-catalog.spec.ts lo exige para todos).
    expect(PATROL_RULE_CATALOG[CLAVE_NUEVA].description).not.toMatch(/[a-z]+[A-Z]/);
  });

  it('ningun archivo de apps/api quedo leyendo la clave vieja', () => {
    const culpables = archivosTs(RAIZ_API).filter(
      (relativo) =>
        !MENCIONES_HISTORICAS_PERMITIDAS.has(relativo) &&
        readFileSync(join(RAIZ_API, relativo), 'utf8').includes(CLAVE_VIEJA),
    );
    expect(culpables).toEqual([]);
  });
});

describe('migracion del dato guardado', () => {
  it('el sello del archivo, el de la clase y el campo name coinciden', () => {
    // TypeORM ordena por el sufijo numerico de la CLASE. Si los tres no
    // coinciden, la migracion corre fuera de orden o se re-aplica.
    expect(SQL).toContain('export class RenameGpsSharingMandatory1725994800000');
    expect(SQL).toContain("name = 'RenameGpsSharingMandatory1725994800000'");
  });

  it.each(TABLAS_TODAS)('%s entra en el renombre', (tabla) => {
    expect(SQL).toMatch(new RegExp(`tabla: '${tabla}'`));
    expect(SQL).toMatch(new RegExp(`trigger: '${tabla}_config_audit'`));
  });

  it('las tres tablas con tenant sueltan FORCE y lo devuelven; platform_rules no', () => {
    // Sin esto el UPDATE no ve NI UNA fila (FORCE alcanza al dueño de la tabla)
    // y la migracion "termina bien" sobre cero filas.
    expect(SQL).toContain('NO FORCE ROW LEVEL SECURITY');
    expect(SQL).toContain('ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY');
    for (const tabla of TABLAS_CON_RLS) {
      expect(SQL).toMatch(new RegExp(`tabla: '${tabla}'[^}]*rls: true`));
    }
    // platform_rules es la unica sin tenant_id y sin RLS.
    expect(SQL).toMatch(new RegExp(`tabla: 'platform_rules'[^}]*rls: false`));
  });

  it('apaga y vuelve a encender el trigger de auditoria de configuracion', () => {
    // Encendido, el historial de cada empresa diria que alguien le cambio la
    // regla de GPS la noche del despliegue; ademas el trigger escribe
    // config_change_log, que sin contexto de tenant viola su WITH CHECK.
    expect(SQL).toContain('DISABLE TRIGGER ${trigger}');
    expect(SQL).toContain('ENABLE TRIGGER ${trigger}');
  });

  it('mueve la clave con los parentesis que la precedencia exige', () => {
    // `-` y `||` tienen la misma precedencia y asocian a la izquierda: sin los
    // parentesis se leeria (build || overrides) - clave y el resultado seria otro.
    expect(SQL).toContain('|| (overrides - $1::text)');
    expect(SQL).toContain('jsonb_build_object($2::text, overrides -> $1::text)');
  });

  it('es idempotente: solo toca las filas que todavia tienen la clave vieja', () => {
    expect(SQL).toContain('WHERE jsonb_exists(overrides, $1::text)');
    // El operador `?` es el marcador de parametro de varios drivers; no se juega
    // con eso dentro de una migracion.
    expect(SQL).not.toMatch(/overrides \? /);
  });

  it('no lee el resultado del UPDATE como si fuera un arreglo de filas', () => {
    // El driver devuelve [filas, rowCount] en UPDATE/DELETE. Por eso el UPDATE
    // va envuelto en un CTE y lo que se ejecuta arriba es un SELECT.
    expect(SQL).toContain('WITH movidas AS (');
    expect(SQL).toContain('SELECT count(*)::int AS filas FROM movidas');
  });

  it('falla ruidosamente si alguna fila conserva la clave vieja', () => {
    expect(SQL).toMatch(/throw new Error\(/);
    expect(SQL).toContain('quedaron');
  });

  it('se puede revertir de verdad, no como tramite', () => {
    expect(SQL).toContain('async down(');
    expect(SQL).toContain('moverClave(queryRunner, CLAVE_NUEVA, CLAVE_VIEJA)');
    expect(SQL).toContain('moverClave(queryRunner, CLAVE_VIEJA, CLAVE_NUEVA)');
  });

  it('no reescribe el historial de auditoria', () => {
    // El historial es append-only: las filas viejas dicen gpsSharingRequired
    // porque asi se llamaba la regla ese dia. Reescribirlo es falsificarlo.
    expect(SQL).not.toMatch(/UPDATE\s+config_change_log/);
    expect(SQL).not.toMatch(/UPDATE\s+platform_config_change_log/);
  });

  it('no toca updated_at: la empresa no cambio su configuracion', () => {
    expect(SQL).not.toMatch(/SET[^;]*updated_at\s*=/);
  });
});
