import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rondas por comenzar, para el aviso al guardia (#43).
 *
 * QUE PROBLEMA RESUELVE
 * ---------------------
 * El criterio de aceptacion del issue es "un guardia recibe el aviso de inicio
 * de ronda CON LA APP CERRADA". Con la app cerrada no hay pantalla que consultar
 * ni request que dispare nada: el aviso lo tiene que empujar el servidor, y para
 * empujarlo hay que saber que rondas estan por empezar en toda la plataforma.
 *
 * Hoy no existe ese listado. Las alertas de ronda (#128) se detectan cuando el
 * SUPERVISOR abre su tablero, o sea DESPUES del hecho y solo si alguien esta
 * mirando; y ademas avisan de lo que ya salio mal. Este listado es el contrario:
 * mira hacia adelante y su destinatario es el GUARDIA.
 *
 * POR QUE UNA FUNCION Y NO UNA CONSULTA DIRECTA
 * ---------------------------------------------
 * Exactamente por lo mismo que `report_dispatch_backlog` (#86): el barrido corre
 * en un worker, sin request y por lo tanto SIN tenant. No puede setear
 * `app.tenant_id` porque justamente lo que necesita saber es de que empresas hay
 * rondas por empezar. Con `patrols` y `tenants` bajo RLS con FORCE, una consulta
 * directa desde voxia_app devolveria cero filas siempre —la politica falla
 * cerrada, que es lo correcto— y el aviso no saldria nunca.
 *
 * Es SECURITY DEFINER, igual que `report_dispatch_backlog` y
 * `platform_list_tenants`: corre como el dueño de las tablas y no como
 * voxia_app, que sigue sin BYPASSRLS.
 *
 * Y exige NO tener contexto de tenant. Es el unico cerrojo que el worker puede
 * cumplir (no tiene rol ni usuario) y cierra la funcion para cualquier request,
 * que siempre setea `app.tenant_id`. Sin ese cerrojo, cualquier sesion de la
 * aplicacion podria enumerar pares (tenant_id, patrol_id) de todas las empresas.
 *
 * QUE DEVUELVE, Y QUE NO
 * ----------------------
 * SOLO identificadores: tenant_id y patrol_id. Ni el nombre del recinto, ni el
 * del guardia, ni la hora. Todo lo que hace falta para armar el aviso lo lee
 * despues el barrido DENTRO de la transaccion de esa empresa, con `app.tenant_id`
 * puesto y sujeto a RLS como cualquier request. Una funcion cruza-tenants que
 * devolviera datos de negocio seria una puerta trasera; esta devuelve dos UUID.
 *
 * NO HAY TABLA NUEVA, Y ES DELIBERADO
 * -----------------------------------
 * La tentacion es una bitacora `patrol_start_notices` que marque "a esta ronda ya
 * se le aviso". No hace falta: el "una sola vez" ya lo sostiene el jobId de la
 * cola de push, que se deriva del hecho (`patrol-start:<patrolId>` + destinatario)
 * y cuyos jobs se retienen (`removeOnComplete: false`, ver push.service.ts). Una
 * tabla mas seria una segunda fuente de verdad para lo mismo, con su RLS, sus
 * privilegios y su purga, y el dia que discrepen gana la que nadie mira.
 *
 * Lo que se pierde: si a Redis se le limpia la base, un guardia puede recibir dos
 * veces el aviso de la misma ronda. Un recordatorio repetido de que la ronda
 * empieza en diez minutos es ruido menor y de vida corta; el precio de evitarlo
 * es una tabla permanente.
 *
 * POR QUE `> now()` Y NO SOLO LA VENTANA
 * --------------------------------------
 * Una ronda cuya hora ya paso no esta "por comenzar": esta atrasada, y de eso
 * avisa `alertas-ronda` (kind 'no_iniciada') al SUPERVISOR. Sin este filtro, el
 * guardia recibiria un "tu ronda esta por comenzar" media hora despues de la
 * hora, que es la clase de aviso que enseña a ignorar los avisos.
 *
 * LAS VOLUNTARIAS NO ENTRAN (#133), con el mismo criterio que las tres primeras
 * ramas del detector de alertas: la ronda voluntaria es cobertura extra que el
 * guardia decidio hacer, no algo programado que haya que recordarle.
 */
export class CreatePatrolStartNoticeBacklog1725998400000 implements MigrationInterface {
  name = 'CreatePatrolStartNoticeBacklog1725998400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION patrol_start_notice_backlog(
        max_lead_minutes integer,
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
          AND tenant.status = 'active'
          AND patrol.status = 'pendiente'
          AND NOT patrol.is_voluntary
          AND patrol.scheduled_start_at > now()
          AND patrol.scheduled_start_at <= now() + make_interval(mins => max_lead_minutes)
        ORDER BY patrol.scheduled_start_at
        LIMIT max_rows
      $$
    `);

    // Una empresa suspendida no recibe avisos: se le corto el servicio, no se le
    // sigue empujando trabajo al telefono de sus guardias. `tenants.status` solo
    // admite 'active' y 'suspended' (ver 1722350000000-CreateIdentitySchema).

    // El orden es ASCENDENTE, al reves que en report_dispatch_backlog. Alla lo
    // que se posterga son informes viejos, que ya valen menos; aca lo que se
    // posterga por el techo de `max_rows` es un aviso que se VENCE a su hora.
    // La ronda que empieza antes es la que primero deja de poder avisarse.

    // El indice que sostiene la consulta. `patrols_schedule_idx` empieza por
    // tenant_id, asi que no sirve para un barrido que cruza empresas: Postgres
    // haria un recorrido completo de patrols cada pasada. Parcial por
    // `status = 'pendiente'` porque es la unica rama que este barrido mira, y
    // porque una ronda deja de estar pendiente para siempre en cuanto arranca:
    // el indice se mantiene chico solo.
    await queryRunner.query(`
      CREATE INDEX patrols_inicio_pendiente_idx
      ON patrols (scheduled_start_at)
      WHERE status = 'pendiente'
    `);

    // Igual que el resto de las funciones SECURITY DEFINER del proyecto: nadie
    // por defecto, y EXECUTE explicito solo para el rol de la aplicacion.
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION patrol_start_notice_backlog(integer, integer) FROM PUBLIC`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          GRANT EXECUTE ON FUNCTION patrol_start_notice_backlog(integer, integer) TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS patrol_start_notice_backlog(integer, integer)`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS patrols_inicio_pendiente_idx`);
  }
}
