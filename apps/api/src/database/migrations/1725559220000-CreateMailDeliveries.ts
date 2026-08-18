import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registro de envios de correo y su estado por notificacion (#44).
 *
 * POR QUE NO ALCANZA CON report_deliveries (#86)
 * `report_deliveries` es la bitacora de DESPACHO del informe de una ronda: dice
 * que el sistema decidio mandarlo y a quien, y existe para que reprocesar la
 * ronda no lo mande dos veces. No dice que paso despues. Con esa tabla sola, la
 * pregunta de soporte "¿le llego el informe al cliente?" se responde "lo
 * despachamos", que no es lo mismo.
 *
 * Esta tabla registra el ciclo de vida del CORREO: encolado -> enviado (el
 * servidor SMTP lo acepto) -> entregado / rebotado / reclamo (lo reporta el
 * proveedor por webhook) o fallido (se agotaron los reintentos). Cubre todos los
 * correos del producto, no solo los informes: invitaciones, recuperacion de
 * clave, escalamiento y fallas de checklist quedan igual de auditables.
 *
 * SE LLAMA mail_deliveries Y NO notification_deliveries A PROPOSITO. La fila
 * tiene destinatario de correo obligatorio; un aviso push no tiene correo y su
 * registro necesita otras columnas. Una tabla "generica" con la mitad de las
 * columnas nulas no registra ninguno de los dos canales bien. El push (#113)
 * lleva su propio registro cuando se implemente.
 *
 * LA LLAVE ES job_id, NO EL DESTINATARIO NI EL ASUNTO
 * `job_id` es el identificador del job de BullMQ, que ya es el sha256 de la
 * clave de idempotencia del correo (ver mail-queue.service.ts). Es estable,
 * unico por hecho de negocio y no filtra correos ni identificadores en claro.
 * Como es la misma llave que usa la cola para deduplicar, el UNIQUE de aca hace
 * que reencolar el mismo correo no genere una segunda fila: el registro y la
 * cola cuentan lo mismo.
 *
 * NO SE GUARDA EL ASUNTO NI EL CUERPO. Para responderle a soporte basta la
 * plantilla, el destinatario y el estado; el texto renderizado arrastra nombres
 * de guardias y de recintos sin agregar nada a la respuesta.
 */
export class CreateMailDeliveries1725559220000 implements MigrationInterface {
  name = 'CreateMailDeliveries1725559220000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mail_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- La FK directa a tenants NO es redundante con las compuestas de mas
        -- abajo. Esas dos son MATCH SIMPLE con columna nullable: cuando
        -- recipient_user_id o patrol_id son NULL la restriccion ni se evalua, y
        -- las dos son NULL en todo correo que no sea despacho de informe —que
        -- es la mayoria—. Sin este ON DELETE CASCADE, purgar la empresa
        -- (platform_purge_tenant, que borra tenants y confia en las cascadas)
        -- dejaria filas huerfanas con el correo de una persona adentro. Eso es
        -- justo lo que #33 y la ley 21.719 no permiten.
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Clave de catalogo de la plantilla ('informe-ronda', 'invitacion'...),
        -- no el asunto renderizado. Se valida con regex y no con un CHECK IN
        -- para que agregar una plantilla no exija una migracion.
        template_key text NOT NULL
          CONSTRAINT mail_deliveries_plantilla_check
          CHECK (template_key ~ '^[a-z][a-z0-9:_-]{0,79}$'),
        -- Normalizado a minusculas desde la aplicacion, igual que en
        -- report_deliveries: "Jefe@Cliente.cl" y "jefe@cliente.cl" son la misma
        -- casilla y tienen que verse como una sola en la vista de soporte.
        recipient_email text NOT NULL
          CONSTRAINT mail_deliveries_correo_check
          CHECK (position('@' in recipient_email) > 1),
        -- Nulo cuando el destinatario es un correo fijo de las reglas (el jefe
        -- de operaciones del cliente final, que no es usuario del sistema).
        recipient_user_id uuid,
        -- Nulo en todo correo que no sea de una ronda (invitaciones, claves).
        -- Es lo que permite responder el criterio del issue con una sola
        -- consulta indexada.
        patrol_id uuid,
        job_id text NOT NULL
          CONSTRAINT mail_deliveries_job_check CHECK (job_id ~ '^[0-9a-f]{64}$'),
        -- Message-ID que devolvio el servidor SMTP. Es la llave con la que el
        -- webhook del proveedor reporta la entrega.
        provider_message_id text
          CONSTRAINT mail_deliveries_mensaje_check
          CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 400),
        status text NOT NULL DEFAULT 'encolado'
          CONSTRAINT mail_deliveries_estado_check
          CHECK (status IN ('encolado', 'enviado', 'entregado', 'rebotado', 'reclamo', 'fallido')),
        attempts integer NOT NULL DEFAULT 0
          CONSTRAINT mail_deliveries_intentos_check CHECK (attempts >= 0),
        -- Motivo del ultimo fallo, ya recortado y saneado por la aplicacion. Un
        -- rebote SMTP es texto del servidor del destinatario: se guarda para que
        -- soporte lo lea, no se escribe en los logs.
        last_error text
          CONSTRAINT mail_deliveries_error_check
          CHECK (last_error IS NULL OR length(last_error) <= 300),
        queued_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        delivered_at timestamptz,
        -- Cuando el envio termino MAL, sea cual sea la forma: rebote, reclamo de
        -- spam o reintentos agotados. Un solo instante y no uno por estado
        -- porque los tres son mutuamente excluyentes.
        failed_at timestamptz,
        -- Reencolar el mismo correo no crea una segunda fila: es la misma
        -- garantia que da la cola, escrita donde sobrevive a limpiar Redis.
        UNIQUE (tenant_id, job_id),
        FOREIGN KEY (tenant_id, recipient_user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, patrol_id)
          REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT mail_deliveries_envio_check
          CHECK (sent_at IS NULL OR sent_at >= queued_at),
        -- No hay entrega sin envio.
        --
        -- Si el webhook llegara ANTES de que se registre el envio, la fila se
        -- queda como esta y el evento SE PIERDE: el endpoint responde 202 con
        -- aplicado en false y el proveedor no reintenta. Aca decia que
        -- reintentaba y era falso. Distinguir "evento repetido" de "todavia no
        -- hay envio" para contestar 409 y provocar el reintento es una decision
        -- del traductor del proveedor (#9) y esta anotada como pendiente en
        -- INTEGRACION.md; el orden normal —SMTP acepta, despues el proveedor
        -- reporta— no pasa por ese caso.
        CONSTRAINT mail_deliveries_entrega_check
          CHECK (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)),
        CONSTRAINT mail_deliveries_falla_check
          CHECK (failed_at IS NULL OR failed_at >= queued_at),
        CONSTRAINT mail_deliveries_encolado_check
          CHECK (status <> 'encolado' OR (sent_at IS NULL AND delivered_at IS NULL))
      )
    `);

    // La pregunta del issue: que se envio de esta ronda y a quien. Parcial
    // porque la mayoria de los correos del producto no son de una ronda.
    await queryRunner.query(
      `CREATE INDEX mail_deliveries_ronda_idx
       ON mail_deliveries (tenant_id, patrol_id) WHERE patrol_id IS NOT NULL`,
    );
    // La vista de soporte lista lo ultimo primero; el purgado por retencion
    // recorre el otro extremo del mismo indice.
    await queryRunner.query(
      `CREATE INDEX mail_deliveries_recientes_idx
       ON mail_deliveries (tenant_id, queued_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX mail_deliveries_mensaje_idx
       ON mail_deliveries (tenant_id, provider_message_id)
       WHERE provider_message_id IS NOT NULL`,
    );
    // El UNIQUE (tenant_id, job_id) ya deja el indice por el que buscan el
    // worker y el webhook: no hace falta otro.

    await queryRunner.query(`ALTER TABLE mail_deliveries ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE mail_deliveries FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY mail_deliveries_isolation ON mail_deliveries
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
          -- DELETE existe solo para el purgado por retencion: la fila guarda el
          -- correo de una persona de contacto y no se conserva para siempre.
          GRANT SELECT, INSERT, DELETE ON mail_deliveries TO sentrycore_app;
          -- El REVOKE va ANTES del GRANT por columna y no es decorativo:
          -- 01-app-role.sh deja un ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
          -- INSERT, UPDATE, DELETE ON TABLES TO sentrycore_app, asi que sentrycore_app
          -- nace con UPDATE sobre TODA la tabla en el mismo instante en que se
          -- crea. Sin quitarlo primero, el GRANT por columna solo sumaria un
          -- privilegio que ya existe y no acotaria nada. Ademas PostgreSQL
          -- revoca las columnas junto con la tabla, asi que el orden importa:
          -- al reves, el REVOKE se llevaria puesto el GRANT de abajo.
          REVOKE UPDATE ON mail_deliveries FROM sentrycore_app;
          -- UPDATE acotado por COLUMNA. Lo que cambia despues de encolar es el
          -- estado del envio y nada mas: destinatario, plantilla, ronda y hora
          -- de encolado quedan congelados, que es lo que hace que la fila sirva
          -- para auditar y no solo para mirar.
          GRANT UPDATE (
            status,
            attempts,
            last_error,
            provider_message_id,
            sent_at,
            delivered_at,
            failed_at
          ) ON mail_deliveries TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE mail_deliveries`);
  }
}
