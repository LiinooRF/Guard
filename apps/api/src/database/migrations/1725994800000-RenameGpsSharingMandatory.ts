import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renombre de la regla `gpsSharingRequired` -> `gpsSharingMandatory`.
 *
 * POR QUE HAY MIGRACION SI "SOLO" SE RENOMBRA UNA VARIABLE
 * -------------------------------------------------------
 * Porque la regla NO es una variable: es una CLAVE de un jsonb persistido. Los
 * cuatro niveles de la cascada guardan las desviaciones en una columna
 * `overrides jsonb` (`platform_rules`, `tenant_rules` de #16, y `site_rules` /
 * `checkpoint_rules` de #80), o sea una clave por regla dentro del objeto:
 *
 *     {"complianceThreshold": 85, "gpsSharingRequired": false}
 *
 * Si el codigo pasa a leer `gpsSharingMandatory` y las filas siguen diciendo
 * `gpsSharingRequired`, esas filas quedan huerfanas. Y no fallan ruidosamente:
 * `sanitizeOverrides()` (rules/rule-overrides.ts) descarta con un warning toda
 * clave que no este en el schema, asi que el valor guardado desaparece y manda
 * el default del producto, que es `true` = OBLIGATORIO.
 *
 * Traducido a terreno: la empresa que habia elegido GPS OPCIONAL amanece con
 * GPS OBLIGATORIO, y el guardia que niega el permiso de ubicacion deja de poder
 * iniciar su ronda (GpsPolicyService.assertPatrolStartAllowed, #77). Un
 * renombre "cosmetico" bloquea turnos. Por eso el dato se migra junto con el
 * codigo y en el mismo despliegue.
 *
 * COLUMNAS VERIFICADAS CONTRA LAS MIGRACIONES QUE CREAN LAS TABLAS
 * ---------------------------------------------------------------
 *   platform_rules   (id, overrides, updated_at, updated_by)   -> 1725375600000
 *   tenant_rules     (tenant_id, overrides, updated_at)        -> 1723906800000
 *   site_rules       (tenant_id, site_id, overrides, ...)      -> 1725375600000
 *   checkpoint_rules (tenant_id, checkpoint_id, overrides, ...)-> 1725375600000
 *
 * Las cuatro guardan la regla DENTRO de `overrides`: no hay una columna por
 * regla, asi que no hay ningun ALTER TABLE que hacer, solo mover una clave. Las
 * cuatro tienen ademas un CHECK `jsonb_typeof(overrides) = 'object'`, que el
 * resultado sigue cumpliendo porque `jsonb_build_object(...) || (jsonb)` es un
 * objeto.
 *
 * `checkpoint_rules` entra aunque esta regla no sea configurable por punto
 * (scopes: platform, tenant, site). Una fila escrita a mano o por un panel
 * viejo puede tener la clave igual, y el objetivo es que despues de esto NO
 * quede ninguna fila con el nombre viejo en ninguna parte.
 *
 * POR QUE SE QUITA `FORCE` UN INSTANTE
 * ------------------------------------
 * Las tres tablas con tenant llevan `FORCE ROW LEVEL SECURITY`, y `FORCE`
 * alcanza tambien al DUEÑO de la tabla. Una migracion corre sin `app.tenant_id`
 * puesto, asi que la politica compara contra NULL y el UPDATE no veria NI UNA
 * fila: se aplicaria "con exito" sobre cero filas y el problema recien
 * aparecería en produccion, con los turnos bloqueados. Este repo tiene las dos
 * versiones escritas (1725289200000 dice que el dueño NO ve las filas;
 * 1725559210000 asume que si); esta migracion no depende de cual sea cierta en
 * cada ambiente.
 *
 * Se quita `FORCE` y se restaura en el mismo `up()`, tabla por tabla. Si el rol
 * de migracion no fuera dueño de la tabla, el ALTER falla RUIDOSAMENTE — que es
 * exactamente lo que se quiere, en vez de un UPDATE silencioso sobre cero
 * filas.
 *
 * POR QUE SE APAGA EL TRIGGER DE AUDITORIA
 * ----------------------------------------
 * Las cuatro tablas tienen trigger de auditoria de configuracion (#84,
 * migracion 1725559210000). Si se deja encendido, cada empresa recibe DOS filas
 * en su historial: "Exigir permiso de ubicacion: si -> sin definir (hereda)" y
 * "gpsSharingMandatory: sin definir -> si". Es decir, el historial diria que
 * alguien le cambio la regla de GPS a todos los clientes la noche del
 * despliegue, que es precisamente la pregunta que ese historial existe para
 * responder bien.
 *
 * Y hay una razon dura ademas de la cosmetica: el trigger inserta en
 * `config_change_log`, que tiene `FORCE ROW LEVEL SECURITY` y
 * `WITH CHECK (tenant_id = app_tenant_id())`. Sin contexto de tenant esa
 * insercion viola la politica y voltea la migracion entera.
 *
 * El registro de que esto paso es esta migracion, no una fila que finge ser un
 * cambio de configuracion que nadie hizo.
 *
 * SI ALGO FALLA EN EL MEDIO
 * -------------------------
 * Lo que restaura `FORCE` y el trigger es el ROLLBACK, no un `finally`: el DDL
 * de PostgreSQL es transaccional y TypeORM corre las migraciones dentro de una
 * transaccion (`data-source.ts` no cambia `migrationsTransactionMode`, cuyo
 * valor por defecto es "all"). Un `finally` seria peor: si el UPDATE falla, la
 * transaccion queda abortada y cualquier sentencia posterior devuelve 25P02,
 * TAPANDO el error real.
 *
 * LO QUE A PROPOSITO NO SE TOCA
 * -----------------------------
 * `config_change_log.param_key` y `platform_config_change_log.param_key`
 * conservan las filas historicas con `gpsSharingRequired`. Es un registro
 * append-only de lo que paso, bajo el nombre que la regla tenia entonces;
 * reescribirlo seria falsificar auditoria. Consecuencia conocida y aceptada:
 * filtrar el historial por `gpsSharingMandatory` no trae los cambios anteriores
 * al renombre — estan bajo el nombre viejo. La vista no se rompe:
 * `parameterCard()` devuelve null para una clave sin ficha y el historial la
 * muestra cruda ("gpsSharingRequired: si -> no"), que es el comportamiento ya
 * cubierto por config-audit.service.spec.ts.
 *
 * Tampoco se toca `updated_at`: la configuracion de la empresa no cambio, solo
 * como se llama la clave por dentro. Moverlo diria que el admin toco algo.
 */

/** Tablas de la cascada. `rls` = lleva FORCE ROW LEVEL SECURITY que hay que soltar. */
const TABLAS = [
  // platform_rules es la unica sin tenant_id y sin RLS (es configuracion de la
  // plataforma, no de una empresa): no hay FORCE que quitar.
  { tabla: 'platform_rules', trigger: 'platform_rules_config_audit', rls: false },
  { tabla: 'tenant_rules', trigger: 'tenant_rules_config_audit', rls: true },
  { tabla: 'site_rules', trigger: 'site_rules_config_audit', rls: true },
  { tabla: 'checkpoint_rules', trigger: 'checkpoint_rules_config_audit', rls: true },
] as const;

const CLAVE_VIEJA = 'gpsSharingRequired';
const CLAVE_NUEVA = 'gpsSharingMandatory';

/**
 * Un `count(*)` como numero. Va con `::int` en el SQL porque `count(*)` es
 * bigint y el driver lo entrega como STRING para no perder precision: sin el
 * cast, `> 0` compararia texto.
 */
async function contar(
  queryRunner: QueryRunner,
  sql: string,
  parametros: readonly unknown[],
): Promise<number> {
  const filas: Array<{ filas: number | string }> = await queryRunner.query(sql, [...parametros]);
  return Number(filas[0]?.filas ?? 0);
}

/**
 * Mueve el valor de una clave a otra dentro de `overrides`, sin tocar el resto.
 *
 * `jsonb_build_object(nueva, valor) || (overrides - vieja)`: el operando DERECHO
 * gana los duplicados, asi que si una fila ya tuviera la clave nueva (una
 * re-corrida, un ambiente a medio migrar) se respeta la NUEVA y se limpia la
 * vieja, en vez de pisarla con el valor antiguo.
 *
 * Los parentesis de `(overrides - $1::text)` NO son decorativos: `-` y `||`
 * tienen la misma precedencia y asocian a la izquierda, asi que sin ellos se
 * leeria `(build || overrides) - clave` y el resultado seria otro.
 *
 * Se usa `jsonb_exists(...)` y no el operador `?` a proposito: `?` es el
 * marcador de parametro de varios drivers y no se gana nada arriesgandolo.
 *
 * IDEMPOTENTE: el `WHERE jsonb_exists(overrides, vieja)` deja fuera las filas
 * que ya no tienen la clave, asi que correrla de nuevo no toca ni una fila. Y
 * `overrides -> vieja` nunca es NULL de SQL bajo ese WHERE; si el valor guardado
 * fuera un `null` de JSON se mueve tal cual, que es lo correcto.
 *
 * REVERSIBLE: `down()` llama a esta misma funcion con las claves al reves. Por
 * eso los nombres viajan como PARAMETROS ($1 vieja, $2 nueva) y no concatenados.
 */
async function moverClave(
  queryRunner: QueryRunner,
  desde: string,
  hacia: string,
): Promise<void> {
  for (const { tabla, trigger, rls } of TABLAS) {
    // El renombre no es un cambio de configuracion: no debe entrar al historial.
    await queryRunner.query(`ALTER TABLE ${tabla} DISABLE TRIGGER ${trigger}`);
    if (rls) {
      await queryRunner.query(`ALTER TABLE ${tabla} NO FORCE ROW LEVEL SECURITY`);
    }

    // El UPDATE va envuelto en un CTE con RETURNING para poder contar las filas
    // movidas: el driver devuelve [filas, rowCount] en un UPDATE suelto, y
    // leerlo como arreglo cuenta 2 SIEMPRE. Envuelto asi, la sentencia de arriba
    // es un SELECT y lo que llega es un arreglo plano de filas de verdad.
    const movidas = await contar(
      queryRunner,
      `WITH movidas AS (
         UPDATE ${tabla}
            SET overrides = jsonb_build_object($2::text, overrides -> $1::text)
                            || (overrides - $1::text)
          WHERE jsonb_exists(overrides, $1::text)
      RETURNING 1
       )
       SELECT count(*)::int AS filas FROM movidas`,
      [desde, hacia],
    );

    // Chequeo que falla ruidosamente si la sentencia no hizo lo que dice. NO
    // detecta el caso "RLS me escondio las filas" —ahi los dos conteos salen en
    // cero—; de eso se encarga el NO FORCE de arriba, que revienta si el rol no
    // es dueño de la tabla. Esto detecta lo otro: que el jsonb quedara mal
    // armado y la clave vieja sobreviviera al UPDATE.
    const huerfanas = await contar(
      queryRunner,
      `SELECT count(*)::int AS filas FROM ${tabla} WHERE jsonb_exists(overrides, $1::text)`,
      [desde],
    );
    if (huerfanas > 0) {
      throw new Error(
        `${tabla}: se movieron ${movidas} fila(s) de "${desde}" a "${hacia}" pero quedaron ` +
          `${huerfanas} con la clave vieja. Abortado a proposito: dejarlas ahi devuelve a esas ` +
          `empresas al default del producto (GPS obligatorio) y les bloquea el inicio de ronda.`,
      );
    }

    if (rls) {
      await queryRunner.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
    }
    await queryRunner.query(`ALTER TABLE ${tabla} ENABLE TRIGGER ${trigger}`);
  }
}

export class RenameGpsSharingMandatory1725994800000 implements MigrationInterface {
  name = 'RenameGpsSharingMandatory1725994800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await moverClave(queryRunner, CLAVE_VIEJA, CLAVE_NUEVA);
  }

  /**
   * Vuelve al nombre viejo. Existe de verdad y no como tramite: si hay que
   * revertir el despliegue, el codigo anterior lee `gpsSharingRequired` y sin
   * este `down()` las empresas con GPS opcional quedarian en obligatorio, que es
   * el mismo bloqueo de turnos pero al reves.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await moverClave(queryRunner, CLAVE_NUEVA, CLAVE_VIEJA);
  }
}
