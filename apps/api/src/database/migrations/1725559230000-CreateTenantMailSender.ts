import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remitente de correo por empresa (#42).
 *
 * QUE FALTABA Y POR QUE NO CABE EN tenant_branding
 * tenant_branding (1724857200000) ya guarda `mail_from_name` y `mail_footer`:
 * el NOMBRE que se muestra y el pie del correo. Eso no alcanza para un producto
 * white-label, porque al cliente final le sigue llegando un correo cuyo
 * Reply-To y cuya direccion son del revendedor. Esta tabla agrega las dos cosas
 * que faltan y que NO son marca visual: a donde contesta el cliente y desde que
 * direccion sale el mensaje.
 *
 * Se separa de tenant_branding a proposito: la marca visual la edita quien
 * maneja el logo y los colores, y esto de aca decide como se entrega correo.
 * Ademas necesita permisos distintos, que es lo que sigue.
 *
 * LA TRAMPA GRANDE: EL From NO SE PUEDE DEJAR ELEGIR LIBRE
 * Poner `From: cualquiera@dominio-del-cliente.cl` desde el relay compartido de
 * la plataforma rompe la alineacion de SPF y DKIM: el mensaje sale firmado por
 * un dominio y dice venir de otro, y DMARC lo manda a spam o lo rechaza. Un
 * correo de invitacion que no llega rompe el onboarding del tenant completo
 * (ver CLAUDE.md, "Sobre el correo").
 *
 * Peor todavia: si el tenant pudiera escribir su propia direccion verificada,
 * cualquier empresa del SaaS podria mandar correo diciendo ser otra. En un
 * producto que comparten muchas empresas de seguridad privada eso no es un bug
 * de deliverability, es suplantacion.
 *
 * Por eso:
 *   - `from_address` es lo que el tenant PIDE. Se guarda, no se usa.
 *   - `from_address_verified_at` es lo que la plataforma ACREDITA una vez que
 *     el dominio tiene SPF, DKIM y DMARC apuntando al relay.
 *   - Mientras `from_address_verified_at` sea NULL, el codigo sale con la
 *     direccion de la plataforma y solo cambia el nombre visible. Ver
 *     plantillas-sobre.ts.
 *
 * El grant por COLUMNA es lo que hace que eso no dependa de que nadie se
 * equivoque en el codigo: sentrycore_app puede escribir `reply_to` y `from_address`,
 * y NO puede escribir `from_address_verified_at`. Un admin no puede
 * auto-verificarse su dominio ni con SQL suelto.
 *
 * Y no es el unico mecanismo: el trigger de mas abajo rechaza el UPDATE de esa
 * columna a quien no sea el dueño de la tabla, aunque el grant se pierda. El
 * INSERT sigue apoyado solo en el grant por columna —el trigger es BEFORE
 * UPDATE— y ahi el camino de escritura de la aplicacion es un unico
 * `INSERT ... ON CONFLICT DO UPDATE` que ni nombra la columna.
 *
 * Reply-To si es libre: no lo firma nadie, no interviene en SPF/DKIM y es
 * justamente lo que hace que el cliente le conteste a su proveedor y no a
 * la plataforma.
 *
 * QUEDA ABIERTO (no lo cierra este issue): quien y como marca
 * `from_address_verified_at`. Depende del proveedor de correo, que es la
 * decision abierta #9. Hoy solo lo puede escribir el dueño de la base
 * (migracion u operaciones), que es lo correcto mientras no exista ese flujo.
 */
export class CreateTenantMailSender1725559230000 implements MigrationInterface {
  name = 'CreateTenantMailSender1725559230000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // El patron del correo se escribe con [.] y no con \. a proposito: dentro de
    // un template literal de TypeScript la secuencia \. se come la barra y el
    // punto pasaria a significar "cualquier caracter". La clase [.] no tiene ese
    // problema y es identica para Postgres.
    await queryRunner.query(`
      CREATE TABLE tenant_mail_sender (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        reply_to text
          CONSTRAINT tenant_mail_sender_reply_to_check
          CHECK (
            reply_to IS NULL
            OR (
              length(reply_to) BETWEEN 6 AND 254
              AND reply_to ~* '^[^@[:space:]]+@[^@[:space:]]+[.][a-z]{2,24}$'
            )
          ),
        from_address text
          CONSTRAINT tenant_mail_sender_from_address_check
          CHECK (
            from_address IS NULL
            OR (
              length(from_address) BETWEEN 6 AND 254
              AND from_address ~* '^[^@[:space:]]+@[^@[:space:]]+[.][a-z]{2,24}$'
            )
          ),
        from_address_verified_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        -- Una verificacion sin direccion que verificar no significa nada, y
        -- dejaria una fila que el codigo tendria que interpretar a mano.
        CONSTRAINT tenant_mail_sender_verificacion_check
          CHECK (from_address_verified_at IS NULL OR from_address IS NOT NULL)
      )
    `);

    // CAMBIAR LA DIRECCION TIENE QUE BORRAR LA VERIFICACION, Y ESO NO PUEDE
    // DEPENDER DEL CODIGO.
    // Sin esto queda un agujero concreto: el admin pide `avisos@su-empresa.cl`,
    // la plataforma lo verifica, y despues el admin lo edita a
    // `alertas@banco-de-alguien.cl`. La fecha de verificacion sigue puesta —no
    // la puede tocar, justamente— y el correo saldria con el From de un dominio
    // que nadie acredito. El trigger corre como dueño de la tabla, asi que no lo
    // limitan los grants por columna y no hay forma de saltarselo desde la API.
    //
    // Y ADEMAS: LA VERIFICACION NO LA MUEVE NADIE QUE NO SEA LA PLATAFORMA.
    // El grant por columna de mas abajo ya lo impide, pero era el UNICO
    // mecanismo, y el trigger de arriba no lo cubria: solo actua cuando CAMBIA
    // `from_address`, asi que un `UPDATE tenant_mail_sender SET
    // from_address_verified_at = now()` a secas lo atraviesa sin tocar nada. El
    // dia que una migracion haga un GRANT amplio (`ON ALL TABLES IN SCHEMA
    // public`, o se re-apliquen los default privileges del script de init),
    // cualquier ADMIN podria auto-acreditar su dominio y mandar correo diciendo
    // ser otra empresa — que es el escenario de suplantacion del comentario de
    // arriba, no un problema de deliverability. Dos capas para lo mismo es lo
    // que ya hace 1725462000000-CreateFeatureFlags con tenant_feature_grants.
    //
    // La excepcion por dueño de la tabla es deliberada y no debilita nada: la
    // acreditacion la escribe hoy el dueño de la base a mano (ver el bloque
    // "QUEDA ABIERTO" de arriba y INTEGRACION.md 9.3). Un trigger que revirtiera
    // el valor sin distinguir quien escribe dejaria esa via muerta y en silencio,
    // que es peor que el agujero: nadie podria acreditar un dominio nunca mas.
    await queryRunner.query(`
      CREATE FUNCTION tenant_mail_sender_reset_verificacion() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.from_address IS DISTINCT FROM OLD.from_address THEN
          NEW.from_address_verified_at := NULL;
          RETURN NEW;
        END IF;

        IF NEW.from_address_verified_at IS DISTINCT FROM OLD.from_address_verified_at
           AND NOT pg_has_role(
             current_user,
             (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
             'MEMBER'
           )
        THEN
          RAISE EXCEPTION
            'from_address_verified_at lo acredita la plataforma, no el tenant'
            USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER tenant_mail_sender_reset_verificacion
      BEFORE UPDATE ON tenant_mail_sender
      FOR EACH ROW EXECUTE FUNCTION tenant_mail_sender_reset_verificacion()
    `);

    await queryRunner.query(`ALTER TABLE tenant_mail_sender ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE tenant_mail_sender FORCE ROW LEVEL SECURITY`);

    // Falla cerrada: app_tenant_id() devuelve NULL cuando no hay contexto y
    // `tenant_id = NULL` no es verdadero, asi que sin contexto no se ve nada.
    await queryRunner.query(`
      CREATE POLICY tenant_mail_sender_isolation ON tenant_mail_sender
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
          -- El REVOKE va PRIMERO y no es decorativo: el script de init
          -- (docker/postgres/init/01-app-role.sh) deja ALTER DEFAULT PRIVILEGES
          -- con SELECT, INSERT, UPDATE y DELETE sobre toda tabla nueva. Sin
          -- revocar el permiso de tabla completa, un GRANT por columna no
          -- restringe absolutamente nada y la verificacion del dominio quedaria
          -- escribible por la aplicacion.
          REVOKE INSERT, UPDATE, DELETE ON tenant_mail_sender FROM sentrycore_app;
          GRANT SELECT ON tenant_mail_sender TO sentrycore_app;
          GRANT INSERT (tenant_id, reply_to, from_address) ON tenant_mail_sender TO sentrycore_app;
          GRANT UPDATE (reply_to, from_address, updated_at) ON tenant_mail_sender TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // El DROP TABLE se lleva el trigger, pero no la funcion: si no se borra
    // aparte, volver a correr la migracion falla con "ya existe".
    await queryRunner.query(`DROP TABLE tenant_mail_sender`);
    await queryRunner.query(`DROP FUNCTION tenant_mail_sender_reset_verificacion()`);
  }
}
