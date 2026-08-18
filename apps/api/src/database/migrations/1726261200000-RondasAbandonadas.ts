import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `rondas_abandonadas()`: las rondas abiertas que nadie va a mirar.
 *
 * El vencimiento perezoso (#258) cubre lo que el guardia y el portal ven: la
 * ronda se vence en el momento en que alguien la toca. Pero una ronda que nadie
 * toca —el guardia se fue, el telefono se quedo sin bateria, el turno no se
 * hizo— se queda `en_curso` para siempre. Y todo lo que cuelga del estado
 * 'vencida' nunca ocurre: las alertas de escalamiento de rondas abandonadas
 * filtran por ese estado, y las estadisticas lo cuentan.
 *
 * SECURITY DEFINER y cruza empresas, igual que `report_dispatch_backlog()`: el
 * barrido corre SIN contexto de tenant porque su pregunta es "en que empresa
 * hay algo pendiente", y esa pregunta no se puede hacer desde dentro de una
 * empresa. Devuelve SOLO identificadores; el vencimiento de cada ronda abre
 * despues su propia transaccion con `app.tenant_id` y vuelve a quedar bajo RLS.
 *
 * EL TOPE ES DELIBERADAMENTE GRUESO. La regla real (`maxPatrolDurationMin`) se
 * resuelve por cascada y puede ser distinta en cada recinto, y esta funcion no
 * puede resolver cascadas. Asi que aqui se usa el MAXIMO que la regla admite
 * (1440 min = 24 h, ver rules.ts) mas un margen: lo que salga de aqui es un
 * CANDIDATO seguro —ninguna configuracion posible lo mantendria vivo— y quien
 * decide de verdad es `rondaVencida()` con las reglas del recinto. Al reves
 * —afinar aqui— se venceria una ronda que su propio recinto todavia considera
 * viva, y eso le cierra el turno a un guardia que esta trabajando.
 */
export class RondasAbandonadas1726261200000 implements MigrationInterface {
  name = 'RondasAbandonadas1726261200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION rondas_abandonadas(
        horas_de_gracia integer DEFAULT 25,
        tope integer DEFAULT 200
      )
      RETURNS TABLE (tenant_id uuid, patrol_id uuid)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
        SELECT p.tenant_id, p.id
        FROM patrols p
        WHERE p.status IN ('pendiente', 'en_curso')
          AND COALESCE(p.started_at, p.scheduled_end_at)
              < now() - make_interval(hours => horas_de_gracia)
        -- Las mas viejas primero: son las que llevan mas tiempo mintiendo en el
        -- panel del supervisor.
        ORDER BY COALESCE(p.started_at, p.scheduled_end_at)
        LIMIT tope
      $$
    `);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION rondas_abandonadas(integer, integer) TO sentrycore_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS rondas_abandonadas(integer, integer)`);
  }
}
