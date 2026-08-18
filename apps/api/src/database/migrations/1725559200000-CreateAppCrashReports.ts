import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cierres inesperados de la app del guardia (#27).
 *
 * POR QUE HAY TABLA Y NO SOLO SENTRY
 * Sentry es una cuenta de la PLATAFORMA: el ADMIN de una empresa de seguridad
 * jamas va a entrar ahi, y no corresponde que entre —veria trazas de todas las
 * empresas—. Pero el que reclama que "el sistema no funciona" es justamente el
 * ADMIN. Esta tabla es lo que le podemos mostrar a el, ya aislado por RLS: en
 * que version, en que modelo de telefono y cuantas veces. Ademas el reporte
 * queda aunque Sentry este apagado, que es el estado por defecto del issue.
 *
 * QUE NO SE GUARDA, A PROPOSITO
 * Ni ubicacion, ni nombre, ni telefono, ni token. El texto del error y la pila
 * pasan por depurarTexto() ANTES de llegar aca (ver
 * observability/crash-scrubber.ts): lo que se guarda ya viene enmascarado, no
 * se enmascara al leer. Si se enmascarara al leer, el dato personal igual
 * estaria en el disco y en los respaldos.
 *
 * user_id SI se guarda, y es deliberado: es un uuid, no un nombre, y sin el
 * no hay forma de frenar a un telefono en bucle que reporta mil veces la misma
 * caida. Ese uuid NO viaja a Sentry — al proveedor externo solo le va el
 * tenant_id, la version y el modelo.
 *
 * EL FK VA A memberships Y NO A users
 * Igual que device_tokens (#113): el reporte es de "esta persona EN esta
 * empresa". Si la membresia se elimina, el CASCADE se lleva sus reportes y no
 * queda rastro de alguien que ya no trabaja ahi. La FK compuesta se apoya en
 * memberships_tenant_user_unique_idx, el indice UNIQUE (tenant_id, user_id)
 * que crea 1722524400000-CreateDemoDomain; el PRIMARY KEY de memberships
 * incluye role_key y por si solo NO serviria de destino.
 *
 * SIN 'api' EN source
 * Los errores del servidor NO se guardan aca. Cuando revienta un endpoint la
 * transaccion del contexto tenant se esta deshaciendo, asi que escribir en la
 * base desde el camino de error es escribir en una transaccion condenada. Esos
 * van directo a Sentry y al log estructurado. La columna existe igual para que
 * el dia que entre otro origen (por ejemplo el panel web) el CHECK obligue a
 * pasar por una migracion.
 */
export class CreateAppCrashReports1725559200000 implements MigrationInterface {
  name = 'CreateAppCrashReports1725559200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE app_crash_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        source text NOT NULL DEFAULT 'app'
          CONSTRAINT app_crash_reports_source_check CHECK (source IN ('app')),
        -- Un ANR o una excepcion no capturada cierran la app; un error
        -- recuperado del puente WebView no. Los dos sirven para diagnosticar,
        -- pero solo el primero justifica despertar a alguien.
        fatal boolean NOT NULL DEFAULT true,
        app_version text NOT NULL
          CONSTRAINT app_crash_reports_app_version_check
          CHECK (length(trim(app_version)) BETWEEN 1 AND 32),
        -- Modelo comercial del telefono ("Redmi 9A"). No identifica a nadie y
        -- es la mitad del diagnostico: los cierres se concentran en la gama
        -- baja que compra el cliente para sus guardias.
        device_model text NOT NULL
          CONSTRAINT app_crash_reports_device_model_check
          CHECK (length(trim(device_model)) BETWEEN 1 AND 64),
        -- Version de Android tal cual la reporta el sistema ("10", "13").
        android_version text NOT NULL
          CONSTRAINT app_crash_reports_android_version_check
          CHECK (length(trim(android_version)) BETWEEN 1 AND 32),
        -- Version del protocolo del puente nativo<->WebView. Sin esto, un
        -- despliegue de la web incompatible con una app vieja se ve igual que
        -- un bug: es la primera pregunta que hay que poder responder.
        bridge_protocol_version integer
          CONSTRAINT app_crash_reports_bridge_check
          CHECK (bridge_protocol_version IS NULL OR bridge_protocol_version BETWEEN 0 AND 1000),
        error_name text NOT NULL
          CONSTRAINT app_crash_reports_error_name_check
          CHECK (length(trim(error_name)) BETWEEN 1 AND 120),
        error_message text NOT NULL
          CONSTRAINT app_crash_reports_error_message_check
          CHECK (length(error_message) BETWEEN 1 AND 2000),
        stack text
          CONSTRAINT app_crash_reports_stack_check
          CHECK (stack IS NULL OR length(stack) <= 20000),
        -- Huella para agrupar caidas iguales. Se calcula en la aplicacion sobre
        -- el texto YA depurado; 16 hex son 64 bits, de sobra para agrupar.
        fingerprint text NOT NULL
          CONSTRAINT app_crash_reports_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
        -- Si el evento salio hacia el proveedor externo. Falso tambien cuando
        -- el envio fallo: sirve para saber si Sentry esta viendo lo mismo que
        -- nosotros antes de discutir por que a el no le llego.
        forwarded boolean NOT NULL DEFAULT false,
        -- Cuando se cayo segun el TELEFONO. El reloj del telefono miente (#73),
        -- por eso no reemplaza a received_at: se guardan los dos.
        occurred_at timestamptz,
        received_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
      )
    `);

    // Lo que consultan el resumen del panel y la purga por retencion.
    await queryRunner.query(
      `CREATE INDEX app_crash_reports_recibido_idx
         ON app_crash_reports (tenant_id, received_at DESC)`,
    );
    // El limite por usuario, y ademas el lado hijo de la FK compuesta: una FK
    // no crea indice sola y sin este el borrado de una membresia hace seq scan.
    await queryRunner.query(
      `CREATE INDEX app_crash_reports_usuario_idx
         ON app_crash_reports (tenant_id, user_id, received_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX app_crash_reports_huella_idx ON app_crash_reports (tenant_id, fingerprint)`,
    );

    await queryRunner.query(`ALTER TABLE app_crash_reports ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE app_crash_reports FORCE ROW LEVEL SECURITY`);
    // Falla cerrada: app_tenant_id() devuelve NULL sin contexto y
    // tenant_id = NULL no es verdadero, asi que sin sesion no se ve nada.
    await queryRunner.query(`
      CREATE POLICY app_crash_reports_isolation ON app_crash_reports
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
          -- DELETE es necesario: la retencion la aplica la propia API al
          -- recibir un reporte, no hay proceso aparte que barra.
          -- UPDATE solo se usa para marcar forwarded.
          GRANT SELECT, INSERT, UPDATE, DELETE ON app_crash_reports TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE app_crash_reports`);
  }
}
