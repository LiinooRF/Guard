import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GPS obligatorio configurable (#77).
 *
 * QUE FALTABA
 * -----------
 * La traza y el consentimiento ya existian (#15, #134, migracion 1724511600000).
 * Lo que NO existia es la parte que el issue pide: que "compartir ubicacion
 * obligatorio u opcional" tenga efecto en el SERVIDOR al iniciar la ronda. Hasta
 * hoy `gpsSharingMandatory` —que cuando se escribio esta migracion se llamaba
 * `gpsSharingRequired`— solo decidia si un escaneo sin fix se marcaba como
 * anomalia; nadie impedia arrancar una ronda con el GPS apagado.
 *
 * DOS TABLAS Y POR QUE SON DOS
 * ----------------------------
 * `gps_permission_reports` es el ESTADO ACTUAL del permiso del sistema operativo
 * en el telefono de cada persona. El servidor no puede averiguarlo solo: lo
 * reporta la app. Se guarda una fila por persona (upsert) porque lo unico que
 * decide el arranque es el estado de ahora; el historial de idas y vueltas del
 * permiso no se usa para nada y seria un registro de conducta de la persona que
 * nadie pidio.
 *
 * `patrol_gps_gate` es la DECISION que se tomo al iniciar CADA ronda: que modo
 * regia, si habia consentimiento, si el telefono compartia ubicacion y si se
 * dejo arrancar. Sin esta fila, una ronda sin traza es ambigua: no se distingue
 * "el guardia no quiso compartir ubicacion y la empresa lo permite" de "el GPS
 * se cayo" o de "el telefono se quedo sin bateria". Esa distincion es
 * exactamente lo que el jefe de operaciones necesita para no acusar a nadie por
 * un subterraneo sin senal.
 *
 * NO se guarda ni un dato de ubicacion aca: eso vive en patrol_tracks y se
 * purga con gpsTrackRetentionDays. Estas dos tablas guardan estado de permiso y
 * decision, que es evidencia de cumplimiento legal, no rastreo.
 *
 * Nombres de columna verificados contra las migraciones que crean las tablas
 * referenciadas: memberships(tenant_id, user_id) en 1722350000000 +
 * memberships_tenant_user_unique_idx de 1722524400000, y patrols(tenant_id, id)
 * en 1722524400000.
 */
export class CreateGpsEnforcement1725462010000 implements MigrationInterface {
  name = 'CreateGpsEnforcement1725462010000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE gps_permission_reports (
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        -- Estado del permiso de ubicacion del sistema operativo, tal como lo
        -- reporta la app:
        --   concedido          = ubicacion tambien en segundo plano
        --   solo_primer_plano  = solo con la app abierta (Android 10+ lo separa)
        --   denegado           = la persona lo rechazo
        --   no_disponible      = el equipo no tiene GPS o el sistema lo apago
        status text NOT NULL
          CONSTRAINT gps_permission_status_check
          CHECK (status IN ('concedido', 'solo_primer_plano', 'denegado', 'no_disponible')),
        -- Instante del reporte. El arranque de ronda exige un reporte RECIENTE
        -- (gpsPermissionReportMaxAgeMin): aceptar uno de hace tres semanas seria
        -- dejar la puerta abierta a conceder el permiso una vez y apagarlo para
        -- siempre.
        reported_at timestamptz NOT NULL DEFAULT now(),
        -- Marca y modelo, igual que gps_consents.device_info. Ni IMEI ni numero:
        -- eso es dato personal que no aporta a la decision.
        device_info text
          CONSTRAINT gps_permission_device_check
          CHECK (device_info IS NULL OR length(device_info) <= 200),
        PRIMARY KEY (tenant_id, user_id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE patrol_gps_gate (
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        -- Modo VIGENTE al momento de decidir. Se congela aca a proposito: si el
        -- admin cambia la regla manana, esta fila tiene que seguir explicando
        -- por que esta ronda de ayer arranco (o no).
        mode text NOT NULL
          CONSTRAINT patrol_gps_gate_mode_check CHECK (mode IN ('obligatorio', 'opcional')),
        permission_status text NOT NULL
          CONSTRAINT patrol_gps_gate_permission_check
          CHECK (permission_status IN (
            'concedido', 'solo_primer_plano', 'denegado', 'no_disponible', 'sin_reporte'
          )),
        consent_granted boolean NOT NULL,
        allowed boolean NOT NULL,
        blocked_reason text
          CONSTRAINT patrol_gps_gate_reason_check
          CHECK (blocked_reason IS NULL OR blocked_reason IN (
            'sin_consentimiento', 'permiso_denegado', 'sin_reporte_de_permiso'
          )),
        decided_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, patrol_id),
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        -- Permitida sin motivo, bloqueada con motivo. Al reves no significa nada
        -- y ensuciaria el informe.
        CONSTRAINT patrol_gps_gate_coherencia_check CHECK (
          (allowed AND blocked_reason IS NULL) OR (NOT allowed AND blocked_reason IS NOT NULL)
        )
      )
    `);

    // Sin indices adicionales a proposito: las dos tablas se leen SIEMPRE por su
    // clave primaria completa (una persona, una ronda). Un indice que ninguna
    // consulta usa solo encarece cada escritura.

    for (const tabla of ['gps_permission_reports', 'patrol_gps_gate']) {
      await queryRunner.query(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${tabla}_isolation ON ${tabla}
        FOR ALL
        USING (
          tenant_id = app_tenant_id()
          OR app_has_audited_support_access(tenant_id)
        )
        WITH CHECK (tenant_id = app_tenant_id())
      `);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxia_app') THEN
          -- Las dos se escriben con INSERT ... ON CONFLICT DO UPDATE, asi que
          -- necesitan INSERT y UPDATE. DELETE no: un reporte de permiso se
          -- reemplaza y una decision de arranque es evidencia. Lo que si borra
          -- es el CASCADE desde patrols, que corre por integridad referencial y
          -- no por privilegios de la aplicacion.
          GRANT SELECT, INSERT, UPDATE ON gps_permission_reports TO voxia_app;
          REVOKE DELETE ON gps_permission_reports FROM voxia_app;
          GRANT SELECT, INSERT, UPDATE ON patrol_gps_gate TO voxia_app;
          REVOKE DELETE ON patrol_gps_gate FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE patrol_gps_gate`);
    await queryRunner.query(`DROP TABLE gps_permission_reports`);
  }
}
