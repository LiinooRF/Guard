import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aviso de geolocalizacion publicado por la empresa (#78).
 *
 * Hasta ahora gps_consents (ver 1724511600000-CreateTrackAndConsent) guardaba
 * una policy_version que llegaba EN EL BODY del dispositivo. Eso registra que
 * alguien apreto "acepto", pero no acredita QUE se le mostro: el texto no vivia
 * en ninguna parte y la version la elegia el cliente. Un consentimiento asi no
 * sirve como prueba de aviso previo, que es justo lo que exige el monitoreo de
 * ubicacion de trabajadores en Chile.
 *
 * Esta tabla mueve la autoridad al servidor: el texto, su version y la URL
 * publica de la politica de privacidad son del TENANT, y quedan fechados y
 * firmados por el admin que los publico.
 *
 * INMUTABLE UNA VEZ PUBLICADO. Un texto editable destruye la evidencia: si "v2"
 * puede cambiar despues de que 40 personas la aceptaron, decir "aceptaron v2" no
 * significa nada. Por eso sentrycore_app recibe UPDATE solo sobre retired_at (grant
 * por columna) y no recibe DELETE. Publicar una version nueva retira la anterior
 * y deja las dos en el historial.
 *
 * La URL de la politica de privacidad se guarda como texto y se exige https: es
 * lo que Google Play pide enlazado desde la ficha y desde la app, y tiene que
 * ser publica. NO se sirve desde aca — resolver un dominio publico por tenant es
 * la decision abierta #19 y este issue no la cierra.
 */
export class CreateConsentPolicies1725472800000 implements MigrationInterface {
  name = 'CreateConsentPolicies1725472800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE consent_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        -- Tope 40 igual que gps_consents.policy_version: es la misma llave con
        -- la que se cruza quien acepto que texto.
        version text NOT NULL
          CONSTRAINT consent_policies_version_check
          CHECK (version ~ '^[A-Za-z0-9._-]{1,40}$'),
        -- El aviso completo, tal cual se le muestra al trabajador. El minimo de
        -- 100 caracteres existe para que nadie publique "acepto el GPS" y de por
        -- cumplido el aviso previo.
        body text NOT NULL
          CONSTRAINT consent_policies_body_check
          CHECK (length(trim(body)) BETWEEN 100 AND 20000),
        privacy_policy_url text NOT NULL
          CONSTRAINT consent_policies_url_check
          CHECK (privacy_policy_url ~* '^https://[^[:space:]]{4,500}$'),
        published_by uuid NOT NULL,
        published_at timestamptz NOT NULL DEFAULT now(),
        retired_at timestamptz,
        UNIQUE (tenant_id, id),
        -- Una version se publica UNA vez: reusar el nombre reescribiria de facto
        -- un texto ya aceptado.
        UNIQUE (tenant_id, version),
        FOREIGN KEY (tenant_id, published_by)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT consent_policies_retired_check
          CHECK (retired_at IS NULL OR retired_at >= published_at)
      )
    `);

    // Un solo aviso VIGENTE por empresa; los retirados se acumulan como
    // historial y por eso el indice es parcial (mismo criterio que
    // gps_consents_active_idx).
    await queryRunner.query(
      `CREATE UNIQUE INDEX consent_policies_vigente_idx
       ON consent_policies (tenant_id) WHERE retired_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX consent_policies_historial_idx
       ON consent_policies (tenant_id, published_at DESC)`,
    );

    await queryRunner.query(`ALTER TABLE consent_policies ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE consent_policies FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY consent_policies_isolation ON consent_policies
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
          GRANT SELECT, INSERT ON consent_policies TO sentrycore_app;
          -- UPDATE acotado por COLUMNA: lo unico que cambia despues de publicar
          -- es el retiro. El texto, la version y la URL quedan congelados, que es
          -- lo que convierte la fila en prueba.
          GRANT UPDATE (retired_at) ON consent_policies TO sentrycore_app;
          REVOKE DELETE ON consent_policies FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE consent_policies`);
  }
}
