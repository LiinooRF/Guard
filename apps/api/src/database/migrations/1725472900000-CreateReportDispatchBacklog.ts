import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rezagadas del envio automatico del informe al cierre (#86).
 *
 * QUE PROBLEMA RESUELVE
 * ---------------------
 * El camino normal es: se marca el punto de cierre -> se encola un despacho ->
 * el worker dibuja el PDF y lo manda. Ese camino tiene un agujero que el propio
 * codigo del despacho documenta y no puede tapar solo:
 *
 *   - El job se encola DENTRO de la transaccion del escaneo, y Redis no
 *     participa de esa transaccion. Si el proceso muere entre el commit y el
 *     `add`, la ronda queda cerrada y sin informe, para siempre.
 *   - El jobId se deriva del patrolId y los jobs completados/fallidos se
 *     retienen para conservar la idempotencia. Si el despacho agota sus cinco
 *     intentos, ese jobId queda ocupado y la ronda NO se puede volver a encolar
 *     nunca mas.
 *   - Si a Redis se le limpia la base, los jobs pendientes desaparecen sin
 *     dejar rastro.
 *
 * En los tres casos el sintoma es el mismo y es el peor posible para este
 * producto: la ronda figura cerrada en el panel y al cliente no le llego nada,
 * y nadie se entera hasta que el cliente reclama. Esta funcion es la lista de
 * esas rondas para que un barrido las rescate.
 *
 * DOS OBJETOS, Y EL SEGUNDO NO ES OPCIONAL
 * ----------------------------------------
 * `report_dispatch_attempts` es la marca de "esta ronda YA se atendio y se
 * decidio no mandar nada". Sin ella, la unica evidencia de que una ronda se
 * atendio serian las filas de `report_deliveries`, y hay dos caminos normales
 * que cierran sin dejar ninguna:
 *
 *   - `autoSendReportOnClose` apagado y la ronda por encima del umbral
 *     (omision `envio_desactivado`). Es un toggle real del catalogo de reglas,
 *     editable por el ADMIN de cada empresa.
 *   - el tenant no tiene ningun admin con correo ni destinatarios configurados
 *     (omision `sin_destinatarios`).
 *
 * Esas rondas quedarian en la lista de rezagadas durante toda la ventana de
 * rescate, ocupando el cupo de `max_rows` pasada tras pasada. Una sola empresa
 * con el envio apagado y volumen alto —200 rondas cerrando juntas en un cambio
 * de turno es normal en este rubro— dejaria el barrido inerte para TODAS las
 * demas, y el log del barrido reportaria rezagadas al tope cada diez minutos,
 * que el operador leeria como "el camino normal esta fallando" cuando en
 * realidad es la configuracion de un cliente.
 *
 * La marca la escribe el despacho (`EnvioInformeService.despachar`), dentro de
 * su transaccion con contexto de tenant y sujeta a RLS como cualquier fila de
 * negocio. Es bitacora, igual que `report_deliveries`: se inserta y se lee,
 * nunca se modifica ni se borra.
 *
 * Ojo con lo que la marca NO cubre a proposito: un despacho que falla (error de
 * red, PDF que no se pudo dibujar) NO deja marca, porque no hubo decision, hubo
 * accidente. Esa ronda sigue apareciendo como rezagada y el barrido puede
 * volver a rescatarla el dia que su job se pierda.
 *
 * POR QUE UNA FUNCION Y NO UNA CONSULTA DIRECTA
 * ---------------------------------------------
 * El barrido corre en un worker, sin request y por lo tanto SIN tenant: no
 * puede setear `app.tenant_id` porque justamente lo que necesita saber es de
 * que tenants hay rondas pendientes. Con `patrols`, `tenants`,
 * `report_deliveries` y `report_dispatch_attempts` bajo RLS con FORCE, una
 * consulta directa desde sentrycore_app devolveria cero filas siempre (la politica
 * falla cerrada, que es lo correcto).
 *
 * Es SECURITY DEFINER, igual que `platform_list_tenants`: corre como el dueño de
 * las tablas —el rol de migraciones, que es superusuario y por eso si se salta
 * RLS— y no como sentrycore_app, que sigue sin BYPASSRLS.
 *
 * QUE DEVUELVE, Y QUE NO
 * ----------------------
 * SOLO identificadores: tenant_id y patrol_id. Ni el nombre de la empresa, ni el
 * del recinto, ni el del guardia, ni un correo. Es lo minimo para encolar el
 * despacho, que despues abre su propia transaccion CON contexto de tenant y
 * vuelve a pasar por RLS como cualquier request. Una funcion cruza-tenants que
 * devolviera datos de negocio seria una puerta trasera; esta devuelve dos UUID.
 *
 * Y ademas exige NO tener contexto de tenant: es el unico cerrojo que el worker
 * puede cumplir (no tiene rol ni usuario) y cierra la funcion para cualquier
 * request, que siempre setea `app.tenant_id`. Falla cerrada como las politicas
 * de RLS: sin el cerrojo, cualquier sesion de la aplicacion podria enumerar
 * pares (tenant_id, patrol_id) de todas las empresas.
 *
 * LOS TRES PARAMETROS
 * -------------------
 * `grace_minutes` evita que el barrido le compita al camino normal: una ronda
 * que cerro hace un minuto todavia tiene su despacho en vuelo. Sin gracia, el
 * barrido dibujaria un segundo PDF en paralelo para nada (no lo mandaria dos
 * veces —de eso se encarga report_deliveries— pero seria trabajo tirado).
 *
 * `lookback_hours` acota hasta donde se rescata. No es solo eficiencia: mandarle
 * al jefe de operaciones el informe de una ronda de la semana pasada, cuando se
 * repara una caida larga, es ruido y no informacion.
 *
 * `max_rows` es el techo de una pasada, para que el primer barrido despues de
 * una caida no encole diez mil despachos de golpe.
 */
export class CreateReportDispatchBacklog1725472900000 implements MigrationInterface {
  name = 'CreateReportDispatchBacklog1725472900000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // La marca de "ya se atendio y no habia nada que mandar". Va primero porque
    // la funcion de mas abajo la consulta y PostgreSQL valida el cuerpo al
    // crearla.
    //
    // Una fila por ronda: el motivo se guarda para poder responder "por que no
    // le llego el informe de esa ronda" sin adivinar, que es la misma pregunta
    // que responde report_deliveries del otro lado.
    await queryRunner.query(`
      CREATE TABLE report_dispatch_attempts (
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        reason text NOT NULL
          CONSTRAINT report_dispatch_attempts_reason_check
          CHECK (reason IN ('envio_desactivado', 'sin_destinatarios')),
        attempted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, patrol_id),
        FOREIGN KEY (tenant_id, patrol_id)
          REFERENCES patrols(tenant_id, id) ON DELETE CASCADE
      )
    `);

    // La PK (tenant_id, patrol_id) ya deja el indice por donde consulta la
    // funcion de abajo: no hace falta otro.

    await queryRunner.query(`ALTER TABLE report_dispatch_attempts ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE report_dispatch_attempts FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY report_dispatch_attempts_isolation ON report_dispatch_attempts
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- Sin UPDATE ni DELETE, por la misma razon que report_deliveries: si
          -- la marca se pudiera borrar, el barrido volveria a rescatar rondas
          -- que ya se atendieron. El script de init deja ALTER DEFAULT
          -- PRIVILEGES con los cuatro verbos, asi que el REVOKE no es adorno.
          GRANT SELECT, INSERT ON report_dispatch_attempts TO sentrycore_app;
          REVOKE UPDATE, DELETE ON report_dispatch_attempts FROM sentrycore_app;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION report_dispatch_backlog(
        grace_minutes integer,
        lookback_hours integer,
        max_rows integer
      )
      RETURNS TABLE (tenant_id uuid, patrol_id uuid)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT patrol.tenant_id, patrol.id
        FROM public.patrols patrol
        JOIN public.tenants tenant ON tenant.id = patrol.tenant_id
        WHERE NULLIF(current_setting('app.tenant_id', true), '') IS NULL
          AND patrol.status IN ('completada', 'incompleta', 'vencida')
          AND tenant.status = 'active'
          AND patrol.closed_at IS NOT NULL
          AND patrol.closed_at <= now() - make_interval(mins => grace_minutes)
          AND patrol.closed_at >= now() - make_interval(hours => lookback_hours)
          AND NOT EXISTS (
            SELECT 1
            FROM public.report_deliveries delivery
            WHERE delivery.tenant_id = patrol.tenant_id
              AND delivery.patrol_id = patrol.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.report_dispatch_attempts attempt
            WHERE attempt.tenant_id = patrol.tenant_id
              AND attempt.patrol_id = patrol.id
          )
        ORDER BY patrol.closed_at DESC
        LIMIT max_rows
      $$
    `);

    // Una empresa suspendida no recibe informes: se le corto el servicio, no se
    // le sigue escribiendo. `tenants.status` solo admite 'active' y 'suspended'
    // (ver 1722350000000-CreateIdentitySchema).

    // El orden es DESCENDENTE a proposito. Con `max_rows` de techo, lo que
    // quede fuera del corte espera a la proxima pasada; si el corte empezara
    // por las mas viejas, un lote grande de rondas atrasadas dejaria afuera
    // justo a la que se perdio recien, que es la que todavia le sirve al
    // cliente. Lo que se posterga son las viejas, cuyo informe ya vale menos.

    // El barrido busca por closed_at y descarta lo que ya tiene entrega o
    // marca. Sin este indice, cada pasada seria un recorrido completo de
    // patrols.
    await queryRunner.query(`
      CREATE INDEX patrols_closed_at_idx
      ON patrols (closed_at)
      WHERE closed_at IS NOT NULL
    `);

    // Igual que el resto de las funciones SECURITY DEFINER del proyecto: nadie
    // por defecto, y EXECUTE explicito solo para el rol de la aplicacion.
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION report_dispatch_backlog(integer, integer, integer) FROM PUBLIC`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT EXECUTE ON FUNCTION report_dispatch_backlog(integer, integer, integer) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS report_dispatch_backlog(integer, integer, integer)`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS patrols_closed_at_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS report_dispatch_attempts`);
  }
}
