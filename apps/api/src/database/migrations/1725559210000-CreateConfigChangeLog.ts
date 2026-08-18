import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auditoria de cambios de CONFIGURACION (#84).
 *
 * `audit_log` (#104) ya registraba que alguien toco las reglas, pero solo con
 * los NOMBRES de los parametros ("reglas.modificadas: complianceThreshold").
 * Con eso no se puede responder la pregunta que motiva el issue —"quien bajo el
 * umbral al 40% el mes pasado"— porque el valor anterior y el nuevo no quedaban
 * en ninguna parte. Esta migracion agrega ese registro: UNA FILA POR PARAMETRO
 * cambiado, con valor anterior, valor nuevo, quien y cuando.
 *
 * POR QUE UN TRIGGER Y NO UNA LLAMADA DESDE EL SERVICIO
 * -----------------------------------------------------
 * Porque una llamada se puede olvidar. Un camino de escritura nuevo que no
 * llame al servicio de auditoria deja el cambio sin rastro, y "poder relajar
 * las reglas sin dejar rastro anula el control". El trigger cuelga de la TABLA:
 * escriba quien escriba —el panel del admin, la funcion de plataforma del
 * SUPERADMIN, un script— la fila queda. Ademas no obliga a tocar
 * rules.service.ts ni feature-flags.service.ts, que son de otros carriles.
 *
 * FALLA CERRADA, Y ESO ES DELIBERADO
 * ----------------------------------
 * `AuditService.record()` traga sus errores a proposito: el usuario ya se creo
 * y revertirlo seria peor. Aca es al reves. El cambio de configuracion y su
 * fila de auditoria ocurren en la MISMA transaccion, asi que hacerlos atomicos
 * no cuesta nada: si la auditoria no puede escribir, el cambio de configuracion
 * tampoco pasa. Un hueco silencioso en el registro de configuracion es
 * exactamente el agujero que este issue viene a tapar.
 *
 * QUE SE AUDITA
 * -------------
 *   area 'reglas'   -> tenant_rules, site_rules, checkpoint_rules (#16, #80)
 *                      y platform_rules (nivel plataforma, sin tenant)
 *   area 'modulos'  -> tenant_feature_preferences: lo que prende el ADMIN (#82)
 *   area 'licencia' -> tenant_feature_grants y plan_feature_flags: el techo que
 *                      mueve el SUPERADMIN
 *
 * SOLO INSERT Y UPDATE, NO DELETE. La aplicacion nunca borra filas de esas
 * tablas: quitar un override es un UPDATE con menos claves, y eso SI queda
 * registrado (new_value NULL = "volvio a heredar"). Los unicos DELETE son en
 * cascada cuando desaparece el recinto, el punto o la empresa entera, y ahi el
 * cambio de configuracion ya no le importa a nadie: el objeto configurado no
 * existe. Auditarlos, en cambio, meteria escrituras dentro del borrado de un
 * tenant y lo haria fallar.
 *
 * NULL NO ES LO MISMO QUE JSON NULL: old_value/new_value en NULL significan
 * "ese nivel no definia el parametro" (heredaba de arriba). Un 'null'::jsonb
 * seria un valor nulo escrito a proposito. Por eso las columnas son jsonb
 * anulables y no jsonb NOT NULL con un centinela.
 *
 * SOBRE LOS VALORES Y LOS DATOS PERSONALES: el historial guarda el valor tal
 * cual, y `reportRecipients` es una lista de correos. Es la configuracion de la
 * propia empresa y la ve exactamente quien ya puede ver esa configuracion en el
 * panel de reglas; sin el valor, el registro no responde la pregunta que motiva
 * el issue. Lo que NO puede pasar es que esos valores salgan por el log de la
 * aplicacion — ahi siguen valiendo las reglas de siempre.
 *
 * Supuesto heredado de CreateFeatureFlags (#82): el dueño del esquema —el rol
 * que corre las migraciones, separado de sentrycore_app— se salta RLS. Es lo que
 * deja que el trigger SECURITY DEFINER escriba una tabla con FORCE ROW LEVEL
 * SECURITY cuando el SUPERADMIN cambia el techo de una empresa sin tener
 * contexto de tenant abierto.
 */
export class CreateConfigChangeLog1725559210000 implements MigrationInterface {
  name = 'CreateConfigChangeLog1725559210000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------
    // Historial por empresa
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE config_change_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- CASCADE y no "sin FK": platform_purge_tenant borra la fila de tenants
        -- y se apoya en las cascadas; despues TenantDataService.executeDeletion
        -- descubre por information_schema TODAS las tablas con columna tenant_id
        -- y revierte el purge entero si alguna quedo con filas. Sin esta FK, el
        -- historial dejaria huerfanas y bloquearia el borrado definitivo de
        -- cualquier empresa que alguna vez haya tocado un parametro. Ademas la
        -- tabla guarda nombres de personas y, via reportRecipients, correos: son
        -- datos que deben desaparecer con la empresa. La unica excepcion
        -- declarada al purge es tenant_deletions (docs/borrado-y-exportacion.md),
        -- y esta no es esa.
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        area text NOT NULL
          CONSTRAINT config_change_log_area_check
          CHECK (area IN ('reglas', 'modulos', 'licencia')),
        scope text NOT NULL
          CONSTRAINT config_change_log_scope_check
          CHECK (scope IN ('tenant', 'site', 'checkpoint')),
        -- El recinto o el punto configurado. Sin FK a proposito, igual que
        -- audit_log.actor_id: el historial tiene que sobrevivir al borrado de lo
        -- que describe, o deja de servir como registro.
        target_id uuid,
        param_key text NOT NULL
          CONSTRAINT config_change_log_param_check CHECK (length(trim(param_key)) > 0),
        old_value jsonb,
        new_value jsonb,
        actor_id uuid,
        actor_label text NOT NULL,
        -- Distingue "lo cambio el admin de la empresa" de "lo cambio soporte de
        -- la plataforma con una ventana abierta" (#109).
        support_access_id uuid,
        changed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        CONSTRAINT config_change_log_target_check
          CHECK ((scope = 'tenant') = (target_id IS NULL)),
        -- Una fila que no cambia nada no es un cambio. Tambien impide la fila
        -- degenerada con los dos valores en NULL.
        CONSTRAINT config_change_log_diff_check
          CHECK (old_value IS DISTINCT FROM new_value)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX config_change_log_tenant_time_idx
       ON config_change_log (tenant_id, changed_at DESC)`,
    );
    // El indice que responde la pregunta del issue: un parametro, un rango.
    await queryRunner.query(
      `CREATE INDEX config_change_log_param_idx
       ON config_change_log (tenant_id, param_key, changed_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX config_change_log_actor_idx
       ON config_change_log (tenant_id, actor_id, changed_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX config_change_log_target_idx
       ON config_change_log (tenant_id, scope, target_id, changed_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE config_change_log ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE config_change_log FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY config_change_log_isolation ON config_change_log
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    // -----------------------------------------------------------------
    // Historial del nivel PLATAFORMA
    //
    // Sin tenant_id y sin RLS, por la misma razon que platform_rules y
    // plan_feature_flags: es configuracion de la PLATAFORMA, comun a todas las
    // empresas, y no contiene datos de ninguna. No hay nada que aislar. Lo que
    // si tiene es control de lectura: sentrycore_app no la toca ni para leer, y el
    // SUPERADMIN la consulta por una funcion que exige su rol.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE platform_config_change_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        area text NOT NULL
          CONSTRAINT platform_config_change_log_area_check
          CHECK (area IN ('reglas', 'licencia')),
        -- El plan de licencia cuando area = 'licencia'. NULL en 'reglas', que es
        -- una fila unica para todo el producto.
        target_key text,
        param_key text NOT NULL
          CONSTRAINT platform_config_change_log_param_check
          CHECK (length(trim(param_key)) > 0),
        old_value jsonb,
        new_value jsonb,
        actor_id uuid,
        actor_label text NOT NULL,
        changed_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT platform_config_change_log_diff_check
          CHECK (old_value IS DISTINCT FROM new_value)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX platform_config_change_log_time_idx
       ON platform_config_change_log (changed_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX platform_config_change_log_param_idx
       ON platform_config_change_log (param_key, changed_at DESC)`,
    );

    // -----------------------------------------------------------------
    // El trigger que arma el diff, parametro por parametro.
    //
    // Una sola funcion para las cuatro tablas de empresa: recibe por argumento
    // el area, el nivel, la columna jsonb y la columna que identifica el objeto
    // configurado. Se lee la fila con to_jsonb() en vez de por nombre de
    // columna para no necesitar SQL dinamico.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION app_log_config_change()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        v_area     text;
        v_scope    text;
        v_columna  text;
        v_llave    text;
        v_fila     jsonb;
        v_nuevo    jsonb;
        v_anterior jsonb;
        v_actor    uuid;
        v_etiqueta text;
        v_soporte  uuid;
        v_clave    text;
      BEGIN
        -- Todo se asigna dentro del BEGIN y no en el DECLARE: asi no depende
        -- del orden en que el motor prepara las variables del trigger.
        v_area    := TG_ARGV[0];
        v_scope   := TG_ARGV[1];
        v_columna := TG_ARGV[2];
        v_llave   := TG_ARGV[3];
        v_fila    := to_jsonb(NEW);
        v_actor   := public.app_user_id();
        v_soporte := NULLIF(current_setting('app.support_access_id', true), '')::uuid;

        v_nuevo := COALESCE(v_fila -> v_columna, '{}'::jsonb);

        IF TG_OP = 'UPDATE' THEN
          v_anterior := COALESCE(to_jsonb(OLD) -> v_columna, '{}'::jsonb);
        ELSE
          v_anterior := '{}'::jsonb;
        END IF;

        IF v_anterior IS NOT DISTINCT FROM v_nuevo THEN
          RETURN NULL;
        END IF;

        -- El actor se guarda por id Y por descripcion: si el usuario se elimina
        -- despues, la fila tiene que seguir diciendo quien fue.
        IF v_actor IS NOT NULL THEN
          SELECT NULLIF(trim(persona.given_name || ' ' || persona.family_name), '')
            INTO v_etiqueta
            FROM public.users persona
           WHERE persona.id = v_actor;
        END IF;
        v_etiqueta := COALESCE(
          v_etiqueta,
          CASE WHEN v_actor IS NULL THEN 'sistema' ELSE 'usuario desconocido' END
        );

        FOR v_clave IN
          SELECT clave FROM jsonb_object_keys(v_anterior) AS clave
          UNION
          SELECT clave FROM jsonb_object_keys(v_nuevo) AS clave
          ORDER BY 1
        LOOP
          IF (v_anterior -> v_clave) IS DISTINCT FROM (v_nuevo -> v_clave) THEN
            INSERT INTO public.config_change_log (
              tenant_id, area, scope, target_id, param_key,
              old_value, new_value, actor_id, actor_label, support_access_id
            ) VALUES (
              (v_fila ->> 'tenant_id')::uuid,
              v_area,
              v_scope,
              CASE WHEN v_llave = '' THEN NULL ELSE (v_fila ->> v_llave)::uuid END,
              v_clave,
              v_anterior -> v_clave,
              v_nuevo -> v_clave,
              v_actor,
              v_etiqueta,
              v_soporte
            );
          END IF;
        END LOOP;

        RETURN NULL;
      END
      $$
    `);

    // Misma logica para el nivel plataforma, que no tiene tenant_id.
    await queryRunner.query(`
      CREATE FUNCTION app_log_platform_config_change()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        v_area     text;
        v_columna  text;
        v_llave    text;
        v_fila     jsonb;
        v_nuevo    jsonb;
        v_anterior jsonb;
        v_actor    uuid;
        v_etiqueta text;
        v_clave    text;
      BEGIN
        v_area    := TG_ARGV[0];
        v_columna := TG_ARGV[1];
        v_llave   := TG_ARGV[2];
        v_fila    := to_jsonb(NEW);
        v_actor   := public.app_user_id();

        v_nuevo := COALESCE(v_fila -> v_columna, '{}'::jsonb);

        IF TG_OP = 'UPDATE' THEN
          v_anterior := COALESCE(to_jsonb(OLD) -> v_columna, '{}'::jsonb);
        ELSE
          v_anterior := '{}'::jsonb;
        END IF;

        IF v_anterior IS NOT DISTINCT FROM v_nuevo THEN
          RETURN NULL;
        END IF;

        IF v_actor IS NOT NULL THEN
          SELECT NULLIF(trim(persona.given_name || ' ' || persona.family_name), '')
            INTO v_etiqueta
            FROM public.users persona
           WHERE persona.id = v_actor;
        END IF;
        v_etiqueta := COALESCE(
          v_etiqueta,
          CASE WHEN v_actor IS NULL THEN 'sistema' ELSE 'usuario desconocido' END
        );

        FOR v_clave IN
          SELECT clave FROM jsonb_object_keys(v_anterior) AS clave
          UNION
          SELECT clave FROM jsonb_object_keys(v_nuevo) AS clave
          ORDER BY 1
        LOOP
          IF (v_anterior -> v_clave) IS DISTINCT FROM (v_nuevo -> v_clave) THEN
            INSERT INTO public.platform_config_change_log (
              area, target_key, param_key, old_value, new_value, actor_id, actor_label
            ) VALUES (
              v_area,
              CASE WHEN v_llave = '' THEN NULL ELSE v_fila ->> v_llave END,
              v_clave,
              v_anterior -> v_clave,
              v_nuevo -> v_clave,
              v_actor,
              v_etiqueta
            );
          END IF;
        END LOOP;

        RETURN NULL;
      END
      $$
    `);

    // -----------------------------------------------------------------
    // Los triggers. AFTER: si la escritura se revierte, la auditoria tambien.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TRIGGER tenant_rules_config_audit
      AFTER INSERT OR UPDATE ON tenant_rules
      FOR EACH ROW
      EXECUTE FUNCTION app_log_config_change('reglas', 'tenant', 'overrides', '')
    `);
    await queryRunner.query(`
      CREATE TRIGGER site_rules_config_audit
      AFTER INSERT OR UPDATE ON site_rules
      FOR EACH ROW
      EXECUTE FUNCTION app_log_config_change('reglas', 'site', 'overrides', 'site_id')
    `);
    await queryRunner.query(`
      CREATE TRIGGER checkpoint_rules_config_audit
      AFTER INSERT OR UPDATE ON checkpoint_rules
      FOR EACH ROW
      EXECUTE FUNCTION app_log_config_change('reglas', 'checkpoint', 'overrides', 'checkpoint_id')
    `);
    await queryRunner.query(`
      CREATE TRIGGER tenant_feature_preferences_config_audit
      AFTER INSERT OR UPDATE ON tenant_feature_preferences
      FOR EACH ROW
      EXECUTE FUNCTION app_log_config_change('modulos', 'tenant', 'preferences', '')
    `);
    await queryRunner.query(`
      CREATE TRIGGER tenant_feature_grants_config_audit
      AFTER INSERT OR UPDATE ON tenant_feature_grants
      FOR EACH ROW
      EXECUTE FUNCTION app_log_config_change('licencia', 'tenant', 'grants', '')
    `);
    await queryRunner.query(`
      CREATE TRIGGER platform_rules_config_audit
      AFTER INSERT OR UPDATE ON platform_rules
      FOR EACH ROW
      EXECUTE FUNCTION app_log_platform_config_change('reglas', 'overrides', '')
    `);
    await queryRunner.query(`
      CREATE TRIGGER plan_feature_flags_config_audit
      AFTER INSERT OR UPDATE ON plan_feature_flags
      FOR EACH ROW
      EXECUTE FUNCTION app_log_platform_config_change('licencia', 'flags', 'plan_key')
    `);

    // -----------------------------------------------------------------
    // Lectura desde plataforma. El SUPERADMIN no tiene empresa en su sesion:
    // sin estas funciones, RLS le esconderia el historial de la empresa que
    // administra, y el nivel plataforma no lo puede leer nadie. Exigen
    // SUPERADMIN activo dentro de la misma transaccion, igual que el resto de
    // las funciones de plataforma.
    //
    // Los parametros llevan prefijo p_ para no chocar con los nombres de las
    // columnas devueltas: 'actor_id' seria ambiguo dentro del cuerpo.
    // -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_config_history(
        p_actor_id uuid,
        p_tenant_id uuid,
        p_area text,
        p_param_key text,
        p_desde timestamptz,
        p_hasta timestamptz,
        p_limite integer
      )
      RETURNS TABLE (
        id uuid,
        area text,
        scope text,
        target_id uuid,
        param_key text,
        old_value jsonb,
        new_value jsonb,
        actor_id uuid,
        actor_label text,
        support_access_id uuid,
        changed_at timestamptz
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(p_actor_id);
        RETURN QUERY
        SELECT cambio.id,
               cambio.area,
               cambio.scope,
               cambio.target_id,
               cambio.param_key,
               cambio.old_value,
               cambio.new_value,
               cambio.actor_id,
               cambio.actor_label,
               cambio.support_access_id,
               cambio.changed_at
          FROM public.config_change_log cambio
         WHERE cambio.tenant_id = p_tenant_id
           AND (p_area IS NULL OR cambio.area = p_area)
           AND (p_param_key IS NULL OR cambio.param_key = p_param_key)
           AND (p_desde IS NULL OR cambio.changed_at >= p_desde)
           AND (p_hasta IS NULL OR cambio.changed_at <= p_hasta)
         ORDER BY cambio.changed_at DESC, cambio.id DESC
         LIMIT LEAST(COALESCE(p_limite, 100), 500);
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_rules_history(
        p_actor_id uuid,
        p_area text,
        p_param_key text,
        p_desde timestamptz,
        p_hasta timestamptz,
        p_limite integer
      )
      RETURNS TABLE (
        id uuid,
        area text,
        target_key text,
        param_key text,
        old_value jsonb,
        new_value jsonb,
        actor_id uuid,
        actor_label text,
        changed_at timestamptz
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(p_actor_id);
        RETURN QUERY
        SELECT cambio.id,
               cambio.area,
               cambio.target_key,
               cambio.param_key,
               cambio.old_value,
               cambio.new_value,
               cambio.actor_id,
               cambio.actor_label,
               cambio.changed_at
          FROM public.platform_config_change_log cambio
         WHERE (p_area IS NULL OR cambio.area = p_area)
           AND (p_param_key IS NULL OR cambio.param_key = p_param_key)
           AND (p_desde IS NULL OR cambio.changed_at >= p_desde)
           AND (p_hasta IS NULL OR cambio.changed_at <= p_hasta)
         ORDER BY cambio.changed_at DESC, cambio.id DESC
         LIMIT LEAST(COALESCE(p_limite, 100), 500);
      END
      $$
    `);

    for (const firma of [
      'app_log_config_change()',
      'app_log_platform_config_change()',
      'platform_config_history(uuid, uuid, text, text, timestamptz, timestamptz, integer)',
      'platform_rules_history(uuid, text, text, timestamptz, timestamptz, integer)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- La aplicacion LEE su historial y no lo escribe. La unica via de
          -- escritura es el trigger, que corre con los privilegios del dueño.
          -- El REVOKE no sobra: el script de init deja ALTER DEFAULT PRIVILEGES
          -- con los cuatro verbos, asi que la tabla nace escribible y un GRANT
          -- SELECT no la achica. Sin esto, la "auditoria" seria un registro que
          -- el propio auditado puede corregir.
          GRANT SELECT ON config_change_log TO sentrycore_app;
          REVOKE INSERT, UPDATE, DELETE ON config_change_log FROM sentrycore_app;

          -- El historial de plataforma no se lee ni con SELECT directo: sale
          -- solo por la funcion que exige SUPERADMIN.
          REVOKE ALL ON platform_config_change_log FROM sentrycore_app;

          GRANT EXECUTE ON FUNCTION platform_config_history(
            uuid, uuid, text, text, timestamptz, timestamptz, integer
          ) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION platform_rules_history(
            uuid, text, text, timestamptz, timestamptz, integer
          ) TO sentrycore_app;

          -- Las funciones de trigger quedan SIN grant: las invoca el motor por
          -- cuenta del dueño de la tabla. Expuestas, no servirian de nada util y
          -- si dejarian llamarlas fuera de contexto.
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [trigger, tabla] of [
      ['tenant_rules_config_audit', 'tenant_rules'],
      ['site_rules_config_audit', 'site_rules'],
      ['checkpoint_rules_config_audit', 'checkpoint_rules'],
      ['tenant_feature_preferences_config_audit', 'tenant_feature_preferences'],
      ['tenant_feature_grants_config_audit', 'tenant_feature_grants'],
      ['platform_rules_config_audit', 'platform_rules'],
      ['plan_feature_flags_config_audit', 'plan_feature_flags'],
    ]) {
      await queryRunner.query(`DROP TRIGGER ${trigger} ON ${tabla}`);
    }

    await queryRunner.query(
      `DROP FUNCTION platform_rules_history(uuid, text, text, timestamptz, timestamptz, integer)`,
    );
    await queryRunner.query(
      `DROP FUNCTION platform_config_history(uuid, uuid, text, text, timestamptz, timestamptz, integer)`,
    );
    await queryRunner.query(`DROP FUNCTION app_log_platform_config_change()`);
    await queryRunner.query(`DROP FUNCTION app_log_config_change()`);
    await queryRunner.query(`DROP TABLE platform_config_change_log`);
    await queryRunner.query(`DROP TABLE config_change_log`);
  }
}
