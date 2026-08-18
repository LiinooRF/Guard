import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provisioning de empresas y metricas globales de plataforma. Issues #105 y #110.
 *
 * NO crea tablas: crea tres funciones SECURITY DEFINER. La razon es la misma que
 * ya justifica platform_create_tenant y platform_purge_tenant, y conviene tenerla
 * escrita porque es la trampa del carril de plataforma:
 *
 * El SUPERADMIN corre SIN contexto de tenant. `app_tenant_id()` es NULL, y toda
 * tabla de negocio tiene RLS con FORCE y politica `tenant_id = app_tenant_id()`,
 * que falla cerrada. Es decir: sentrycore_app sin contexto NO VE NI ESCRIBE NADA en
 * tenants, users, memberships, sites, tenant_rules ni patrols. Un alta de empresa
 * hecha con SQL suelto desde la API simplemente no insertaria.
 *
 * Las dos salidas posibles eran:
 *
 *   (a) setear `app.tenant_id` al uuid del tenant nuevo dentro de la transaccion;
 *   (b) una funcion SECURITY DEFINER con `assert_platform_superadmin` adentro.
 *
 * Se eligio (b). (a) funciona tecnicamente, pero le da a la API la capacidad de
 * fabricarse contexto de CUALQUIER tenant fuera de una sesion autenticada — que
 * es exactamente lo que el diseño de #109 prohibe: entrar a los datos de una
 * empresa tiene que dejar rastro y vencer (support_access_log). Un `set_config`
 * arbitrario no deja ninguna de las dos cosas. Con (b) el unico camino que cruza
 * empresas esta dentro de funciones que exigen ser SUPERADMIN activo, y las
 * politicas RLS quedan intactas.
 *
 * Supuesto del que dependen estas funciones (el mismo de platform_create_tenant):
 * el dueño del esquema —el rol que corre las migraciones, separado de sentrycore_app
 * segun CONTRIBUTING.md— se salta RLS. Si algun dia las migraciones pasaran a
 * correr con un rol sin BYPASSRLS, estas funciones dejarian de ver filas y habria
 * que revisarlas junto con platform_list_tenants y platform_purge_tenant.
 */
export class CreateTenantProvisioning1724770800000 implements MigrationInterface {
  name = 'CreateTenantProvisioning1724770800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // #105 — alta completa de una empresa en UNA sola llamada.
    //
    // Todo o nada: la funcion es UNA sentencia dentro de la transaccion de la
    // API, asi que cualquier excepcion (slug repetido, correo repetido, plan
    // inexistente, o el fallo de encolar la invitacion, que la API lanza
    // despues) revierte tenant, usuario, membresia, reglas y recinto juntos.
    // No existe el estado "tenant creado sin admin".
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_provision_tenant(
        actor_id uuid,
        new_tenant_id uuid,
        new_slug text,
        new_legal_name text,
        new_display_name text,
        new_plan_key text,
        admin_user_id uuid,
        admin_email citext,
        admin_password_hash text,
        admin_given_name text,
        admin_family_name text,
        invitation_token_hash text,
        invitation_expires_at timestamptz,
        rule_overrides jsonb,
        sample_site_id uuid,
        sample_site_branch_name text,
        sample_site_name text,
        sample_site_address text
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        actor_name text;
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);

        IF jsonb_typeof(rule_overrides) <> 'object' THEN
          RAISE EXCEPTION 'rule overrides must be a json object' USING ERRCODE = '22023';
        END IF;
        -- El recinto de ejemplo es opcional pero no parcial: o vienen todos sus
        -- datos o no viene ninguno.
        IF (sample_site_id IS NULL) <> (sample_site_name IS NULL)
          OR (sample_site_id IS NULL) <> (sample_site_address IS NULL)
          OR (sample_site_id IS NULL) <> (sample_site_branch_name IS NULL)
        THEN
          RAISE EXCEPTION 'sample site is incomplete' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.tenants (id, slug, legal_name, display_name, plan_key)
        VALUES (new_tenant_id, new_slug, new_legal_name, new_display_name, new_plan_key);

        INSERT INTO public.users (id, email, password_hash, given_name, family_name)
        VALUES (
          admin_user_id, admin_email, admin_password_hash,
          admin_given_name, admin_family_name
        );

        INSERT INTO public.memberships (tenant_id, user_id, role_key)
        VALUES (new_tenant_id, admin_user_id, 'ADMIN');

        -- Fila de reglas del tenant. NO replica los defaults del producto: si
        -- rule_overrides viene vacio queda '{}' y el tenant opera con lo que
        -- diga rules.ts, que es la invariante de la migracion CreateTenantRules.
        INSERT INTO public.tenant_rules (tenant_id, overrides)
        VALUES (new_tenant_id, rule_overrides);

        IF sample_site_id IS NOT NULL THEN
          INSERT INTO public.sites (id, tenant_id, branch_name, name, address)
          VALUES (
            sample_site_id, new_tenant_id,
            sample_site_branch_name, sample_site_name, sample_site_address
          );
        END IF;

        -- La invitacion se emite por la misma funcion que usa el ADMIN al crear
        -- usuarios: valida vigencia, formato del hash y que la membresia exista.
        PERFORM public.issue_auth_action_token(
          admin_user_id,
          new_tenant_id,
          'invitation',
          invitation_token_hash,
          invitation_expires_at
        );

        INSERT INTO public.platform_audit_log (tenant_id, actor_user_id, action, metadata)
        VALUES (
          new_tenant_id,
          actor_id,
          'tenant.created',
          jsonb_build_object(
            'plan_key', new_plan_key,
            'origen', 'provisioning',
            'admin_user_id', admin_user_id,
            'recinto_ejemplo', sample_site_id IS NOT NULL,
            'reglas_override', (SELECT count(*) FROM jsonb_object_keys(rule_overrides))
          )
        );

        -- Ademas del registro de plataforma, la accion queda en la auditoria DEL
        -- TENANT: su ADMIN tiene que poder ver que su empresa la dio de alta la
        -- plataforma y quien. AuditService.record() no sirve aca porque depende
        -- de app_tenant_id(), que no existe en una operacion de plataforma; se
        -- escribe la misma fila desde adentro de la transaccion, con la ventaja
        -- de que asi no puede quedar el hueco que ese servicio tolera.
        SELECT coalesce(
          nullif(trim(actor.given_name || ' ' || actor.family_name), ''),
          'plataforma'
        )
        INTO actor_name
        FROM public.users actor
        WHERE actor.id = actor_id;

        INSERT INTO public.audit_log (
          tenant_id, actor_id, actor_label, action, entity_type, entity_id, summary
        ) VALUES (
          new_tenant_id,
          actor_id,
          actor_name || ' (plataforma)',
          'empresa.aprovisionada',
          'tenant',
          new_tenant_id,
          'Alta de la empresa con su administrador inicial'
        );

        RETURN jsonb_build_object(
          'tenant_id', new_tenant_id,
          'admin_user_id', admin_user_id,
          'site_id', sample_site_id
        );
      END
      $$
    `);

    // ---------------------------------------------------------------------
    // #110 — metricas por tenant. Es la funcion base: la global agrega sobre
    // esta para que "cuantos estan en riesgo" y "cuales son" nunca discrepen.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_tenant_metrics(actor_id uuid, inactivity_days integer)
      RETURNS TABLE (
        tenant_id uuid,
        slug text,
        display_name text,
        status text,
        created_at timestamptz,
        active_guards integer,
        patrols_this_month integer,
        avg_compliance_pct numeric,
        compliance_sample integer,
        last_activity_at timestamptz,
        days_since_activity integer,
        at_risk boolean
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        IF inactivity_days IS NULL OR inactivity_days < 1 OR inactivity_days > 90 THEN
          RAISE EXCEPTION 'invalid inactivity window' USING ERRCODE = '22023';
        END IF;

        RETURN QUERY
        WITH actividad AS (
          -- Señal de vida REAL, no de planificacion: una ronda programada que
          -- nadie inicio no es actividad. Por eso started_at y no
          -- scheduled_start_at. GREATEST ignora los NULL: el tenant que solo
          -- usa la app offline igual aparece vivo por sync_operations.
          SELECT
            tenant.id AS id,
            GREATEST(
              (SELECT max(patrol.started_at)
                 FROM public.patrols patrol WHERE patrol.tenant_id = tenant.id),
              (SELECT max(scan.scanned_at_server)
                 FROM public.scans scan WHERE scan.tenant_id = tenant.id),
              (SELECT max(evento.reported_at_server)
                 FROM public.field_events evento WHERE evento.tenant_id = tenant.id),
              (SELECT max(operacion.synced_at_server)
                 FROM public.sync_operations operacion WHERE operacion.tenant_id = tenant.id)
            ) AS ultima
          FROM public.tenants tenant
        ),
        mes AS (
          -- Las voluntarias no cuentan contra el cumplimiento programado (#133):
          -- si contaran, un tenant que hace rondas extra se veria peor.
          SELECT
            patrol.tenant_id AS id,
            count(*)::integer AS rondas,
            avg(patrol.compliance_pct) AS promedio,
            count(patrol.compliance_pct)::integer AS muestra
          FROM public.patrols patrol
          WHERE patrol.scheduled_start_at >= date_trunc('month', now())
            AND NOT patrol.is_voluntary
          GROUP BY patrol.tenant_id
        ),
        guardias AS (
          SELECT membership.tenant_id AS id, count(*)::integer AS total
          FROM public.memberships membership
          JOIN public.users usuario ON usuario.id = membership.user_id
          WHERE membership.role_key = 'GUARDIA' AND usuario.is_active
          GROUP BY membership.tenant_id
        )
        SELECT
          tenant.id,
          tenant.slug,
          tenant.display_name,
          tenant.status,
          tenant.created_at,
          coalesce(guardias.total, 0),
          coalesce(mes.rondas, 0),
          round(mes.promedio, 2),
          coalesce(mes.muestra, 0),
          actividad.ultima,
          (floor(extract(epoch FROM now() - actividad.ultima) / 86400))::integer,
          -- Suspendido no es "por irse": ya se fue. Y un tenant mas nuevo que la
          -- ventana no puede estar inactivo hace 7 dias: sin esa condicion toda
          -- empresa recien dada de alta apareceria en la lista de fuga.
          tenant.status = 'active'
            AND tenant.created_at < now() - make_interval(days => inactivity_days)
            AND (
              actividad.ultima IS NULL
              OR actividad.ultima < now() - make_interval(days => inactivity_days)
            )
        FROM public.tenants tenant
        JOIN actividad ON actividad.id = tenant.id
        LEFT JOIN mes ON mes.id = tenant.id
        LEFT JOIN guardias ON guardias.id = tenant.id
        ORDER BY actividad.ultima ASC NULLS FIRST, tenant.display_name;
      END
      $$
    `);

    // ---------------------------------------------------------------------
    // #110 — resumen global. Una sola fila, todo agregado en SQL.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE FUNCTION platform_global_metrics(actor_id uuid, inactivity_days integer)
      RETURNS TABLE (
        active_tenants integer,
        suspended_tenants integer,
        active_guards integer,
        patrols_this_month integer,
        avg_compliance_pct numeric,
        tenants_at_risk integer,
        last_offline_sync_at timestamptz,
        offline_sync_ops_24h integer
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        SELECT
          (SELECT count(*)::integer FROM public.tenants tenant
            WHERE tenant.status = 'active'),
          (SELECT count(*)::integer FROM public.tenants tenant
            WHERE tenant.status = 'suspended'),
          (SELECT count(*)::integer
            FROM public.memberships membership
            JOIN public.users usuario ON usuario.id = membership.user_id
            WHERE membership.role_key = 'GUARDIA' AND usuario.is_active),
          (SELECT count(*)::integer FROM public.patrols patrol
            WHERE patrol.scheduled_start_at >= date_trunc('month', now())
              AND NOT patrol.is_voluntary),
          -- Promedio global ponderado por ronda, no promedio de promedios: un
          -- tenant con 2 rondas no puede pesar lo mismo que uno con 2000.
          (SELECT round(avg(patrol.compliance_pct), 2) FROM public.patrols patrol
            WHERE patrol.scheduled_start_at >= date_trunc('month', now())
              AND NOT patrol.is_voluntary
              AND patrol.compliance_pct IS NOT NULL),
          (SELECT count(*)::integer
            FROM public.platform_tenant_metrics(actor_id, inactivity_days) metrica
            WHERE metrica.at_risk),
          (SELECT max(operacion.synced_at_server) FROM public.sync_operations operacion),
          (SELECT count(*)::integer FROM public.sync_operations operacion
            WHERE operacion.synced_at_server >= now() - interval '24 hours');
      END
      $$
    `);

    for (const firma of [
      `platform_provision_tenant(
        uuid, uuid, text, text, text, text, uuid, citext, text, text, text,
        text, timestamptz, jsonb, uuid, text, text, text
      )`,
      'platform_tenant_metrics(uuid, integer)',
      'platform_global_metrics(uuid, integer)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT EXECUTE ON FUNCTION platform_provision_tenant(
            uuid, uuid, text, text, text, text, uuid, citext, text, text, text,
            text, timestamptz, jsonb, uuid, text, text, text
          ) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION platform_tenant_metrics(uuid, integer) TO sentrycore_app;
          GRANT EXECUTE ON FUNCTION platform_global_metrics(uuid, integer) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION platform_global_metrics(uuid, integer)`);
    await queryRunner.query(`DROP FUNCTION platform_tenant_metrics(uuid, integer)`);
    await queryRunner.query(`
      DROP FUNCTION platform_provision_tenant(
        uuid, uuid, text, text, text, text, uuid, citext, text, text, text,
        text, timestamptz, jsonb, uuid, text, text, text
      )
    `);
  }
}
