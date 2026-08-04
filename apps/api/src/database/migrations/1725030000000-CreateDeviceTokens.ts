import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tokens de dispositivo para notificaciones push (#113).
 *
 * Hoy todo aviso es correo. Un panico o una ronda vencida necesitan algo que
 * SUENE en el telefono del supervisor: el correo llega, pero llega cuando
 * alguien abre la bandeja, y eso no sirve para un evento que se atiende en
 * minutos. El push NO reemplaza al correo — el correo sigue siendo el canal
 * garantizado y trazable; el push es el que despierta.
 *
 * UN TOKEN MUERTO NO ES UN ERROR. Un token deja de servir sola: el guardia
 * desinstala, borra los datos de la app o el sistema lo rota. El proveedor
 * responde que ese token ya no existe y la fila SE BORRA. Acumularlos hace que
 * cada aviso tarde mas —el envio recorre tokens que ya nadie escucha— y
 * ensucia la unica metrica util, "a cuantos dispositivos llego".
 *
 * POR QUE EL TOKEN NO ES UNICO GLOBAL, SINO POR TENANT
 * `UNIQUE (tenant_id, token)`: si la unicidad fuera global, insertar un token
 * que ya existe en OTRA empresa devolveria una violacion de constraint, y ese
 * error —observable desde la API de un tenant— revela que ese dispositivo esta
 * registrado en otra empresa. Es una fuga cruzada por mensaje de error, en un
 * producto donde el aislamiento entre empresas de seguridad privada es el
 * requisito numero uno. Con la unicidad por tenant, cada empresa solo puede
 * comprobar lo suyo.
 *
 * POR QUE EL user_id VA A memberships Y NO A users
 * Un token es de "esta persona EN esta empresa", no de la persona. Si la
 * membresia se elimina —lo dieron de baja de la empresa—, el ON DELETE CASCADE
 * borra sus tokens y deja de recibir alertas de un cliente al que ya no
 * pertenece. Con un FK a users eso habria que acordarse de hacerlo a mano.
 *
 * El SUPERADMIN no aparece aca y es correcto: no tiene tenant ni membresia, y
 * esta es una tabla con tenant_id. Las alertas de terreno son del ADMIN y del
 * SUPERVISOR de la empresa.
 */
export class CreateDeviceTokens1725030000000 implements MigrationInterface {
  name = 'CreateDeviceTokens1725030000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE device_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        token text NOT NULL
          CONSTRAINT device_tokens_token_check
          CHECK (length(trim(token)) BETWEEN 8 AND 4096),
        -- Solo 'android': iOS esta fuera de alcance (CLAUDE.md, decisiones ya
        -- tomadas). El CHECK obliga a una migracion el dia que entre otra
        -- plataforma, que es justo cuando hay que revisar el proveedor.
        platform text NOT NULL
          CONSTRAINT device_tokens_platform_check CHECK (platform IN ('android')),
        -- Version del shell instalado. Sirve para explicar por que un telefono
        -- no abre un deep link nuevo (contrato versionado) sin preguntarle al
        -- guardia que version tiene.
        app_version text
          CONSTRAINT device_tokens_app_version_check
          CHECK (app_version IS NULL OR length(trim(app_version)) BETWEEN 1 AND 32),
        -- Se refresca en cada registro. El shell reregistra al abrir, asi que
        -- un last_seen_at viejo es un dispositivo que no se usa.
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, token),
        FOREIGN KEY (tenant_id, user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
      )
    `);

    // Lo que consulta el envio: los tokens de un usuario. El FK compuesto no
    // crea indice en el lado hijo, y sin este el aviso hace seq scan sobre
    // todos los dispositivos del tenant.
    await queryRunner.query(
      `CREATE INDEX device_tokens_user_idx ON device_tokens (tenant_id, user_id)`,
    );

    await queryRunner.query(`ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY device_tokens_isolation ON device_tokens
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          -- CON DELETE, a diferencia de las tablas de evidencia: un token no es
          -- prueba de nada, es estado de enrutamiento. Borrarlo es la respuesta
          -- correcta a "este dispositivo ya no existe" y al cierre de sesion.
          GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE device_tokens`);
  }
}
