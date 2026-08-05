import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quita al rol de la aplicacion los permisos que nadie le concedio a proposito.
 *
 * `docker/postgres/init/01-app-role.sh:40-41` hace:
 *
 *     ALTER DEFAULT PRIVILEGES IN SCHEMA public
 *       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
 *
 * O sea que el rol arranca con los cuatro permisos en TODA tabla nueva. Eso
 * existe para que nadie tenga que acordarse de un GRANT en cada migracion, y
 * esta bien. Pero tiene una consecuencia que se leia al reves: un
 * `GRANT SELECT, INSERT` **no acota nada**, solo repite dos de los cuatro que ya
 * estaban. Lo unico que quita algo es un REVOKE.
 *
 * Las tablas que quisieron ser append-only si revocan, y estan bien. Estas cinco
 * escribieron su intencion en el GRANT y se quedaron sin el REVOKE, asi que la
 * base concede mas de lo que su propia migracion declara. Se comprobo una por
 * una contra el codigo que ninguna ruta de la aplicacion usa el permiso que se
 * quita.
 *
 * Las dos primeras son las que de verdad importan: su escritura vive dentro de
 * funciones `SECURITY DEFINER` que validan antes de tocar la fila. El sentido de
 * eso es que no se pueda esquivar — y con UPDATE directo se esquivaba.
 */
export class RevokePrivilegiosDeMas1725818400000 implements MigrationInterface {
  name = 'RevokePrivilegiosDeMas1725818400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          RETURN;
        END IF;

        -- Se escriben SOLO por set_platform_rules(), que empieza con
        -- assert_platform_superadmin(actor_id). Con UPDATE directo, esa
        -- comprobacion era decorativa.
        REVOKE INSERT, UPDATE, DELETE ON platform_rules FROM voxia_app;

        -- Idem: issue_auth_action_token() valida antes de acuñar, y
        -- consume_auth_action_token() antes de marcar usado. Con INSERT directo
        -- se podia acuñar un token de recuperacion de contraseña sin validacion.
        REVOKE INSERT, UPDATE, DELETE ON auth_action_tokens FROM voxia_app;

        -- Lo unico que cambia despues de publicar un aviso es el retiro. El
        -- texto, la version y la URL quedan congelados: es lo que convierte la
        -- fila en prueba, y es lo que promete el docblock de su migracion.
        -- El GRANT por columna que ya existe se conserva; hasta ahora convivia
        -- con un UPDATE de tabla completa que lo hacia irrelevante.
        REVOKE UPDATE ON consent_policies FROM voxia_app;
        GRANT UPDATE (retired_at) ON consent_policies TO voxia_app;

        -- Estas dos se insertan y se actualizan desde la aplicacion, nunca se
        -- borran: la politica de acceso y la solicitud de borrado de un tenant
        -- son historia, y borrarlas taparia quien pidio que.
        REVOKE DELETE ON tenant_auth_policies FROM voxia_app;
        REVOKE DELETE ON tenant_deletions FROM voxia_app;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          RETURN;
        END IF;
        GRANT INSERT, UPDATE, DELETE ON platform_rules TO voxia_app;
        GRANT INSERT, UPDATE, DELETE ON auth_action_tokens TO voxia_app;
        GRANT UPDATE ON consent_policies TO voxia_app;
        GRANT DELETE ON tenant_auth_policies TO voxia_app;
        GRANT DELETE ON tenant_deletions TO voxia_app;
      END
      $$
    `);
  }
}
