import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Traza del recorrido (#134) y consentimiento de geolocalizacion (#15).
 *
 * Hasta ahora el GPS solo existia como punto suelto dentro de cada escaneo
 * (scans.latitude/longitude). Eso responde "¿estuvo en el punto?" pero no
 * "¿por donde anduvo?", que es lo que el cliente quiere ver dibujado sobre el
 * mapa.
 *
 * SIN PostGIS, a proposito. Se usa numeric(9,6) igual que scans, field_events y
 * shift_assignments por tres razones concretas:
 *   1. Lo unico que hace hoy el producto con la traza es dibujar una polilinea y
 *      sumar distancias con haversine: aritmetica, no consultas espaciales.
 *   2. La extension hay que instalarla y mantenerla en TODOS los entornos —
 *      docker local, VPS de Dokploy, y el restore de un respaldo falla si la
 *      extension no esta presente en el destino. Es costo operativo permanente
 *      a cambio de nada que se use.
 *   3. Guardamos WGS84 lat/lng, que es exactamente lo que espera geography:
 *      migrar despues es un ALTER con USING, no un rediseño. Cuando aparezcan
 *      geocercas por recinto o consultas de proximidad sobre millones de filas,
 *      se agrega la extension con ese requisito a la vista.
 *
 * gps_consents es la EVIDENCIA de que al trabajador se le informo. En Chile el
 * monitoreo de ubicacion de trabajadores exige aviso previo y proporcionalidad,
 * y Google Play exige divulgacion destacada para ubicacion en segundo plano.
 * Sin esta fila no se guarda ni un punto de traza (lo aplica GeoService).
 */
export class CreateTrackAndConsent1724511600000 implements MigrationInterface {
  name = 'CreateTrackAndConsent1724511600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE patrol_tracks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        -- Hora del telefono al muestrear. No se duplica un recorded_at_server
        -- como en scans: el muestreo llega en LOTE y el instante de servidor
        -- seria el mismo para todo el lote; eso ya lo dice created_at.
        recorded_at_device timestamptz NOT NULL,
        latitude numeric(9,6) NOT NULL,
        longitude numeric(9,6) NOT NULL,
        accuracy_m numeric(7,2),
        battery_pct smallint,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, patrol_id) REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT patrol_tracks_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT patrol_tracks_longitude_check CHECK (longitude BETWEEN -180 AND 180),
        CONSTRAINT patrol_tracks_accuracy_check CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
        CONSTRAINT patrol_tracks_battery_check
          CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100)
      )
    `);
    // Es el indice con el que se dibuja la traza (ordenada por tiempo) y ademas
    // la idempotencia del reenvio offline: la traza es un muestreo periodico, y
    // dos filas del mismo dispositivo con el MISMO instante son el mismo punto
    // mandado dos veces, no dos posiciones.
    await queryRunner.query(
      `CREATE UNIQUE INDEX patrol_tracks_patrol_idx
       ON patrol_tracks (tenant_id, patrol_id, recorded_at_device)`,
    );
    // La purga por retencion (gpsTrackRetentionDays) barre por fecha de llegada.
    await queryRunner.query(
      `CREATE INDEX patrol_tracks_retention_idx ON patrol_tracks (tenant_id, created_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE gps_consents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        granted_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        -- Version del texto que se le mostro. Un texto nuevo NO se hereda: el
        -- consentimiento anterior se cierra y el trabajador acepta de nuevo.
        policy_version text NOT NULL
          CONSTRAINT gps_consents_policy_check
          CHECK (length(trim(policy_version)) BETWEEN 1 AND 40),
        -- Marca y modelo del equipo donde se acepto. Ni IMEI ni numero: eso es
        -- dato personal que no aporta a la prueba.
        device_info text
          CONSTRAINT gps_consents_device_check
          CHECK (device_info IS NULL OR length(device_info) <= 200),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT gps_consents_revoked_check CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
      )
    `);
    // Un solo consentimiento VIGENTE por persona; los revocados se acumulan como
    // historial y por eso el indice es parcial.
    await queryRunner.query(
      `CREATE UNIQUE INDEX gps_consents_active_idx
       ON gps_consents (tenant_id, user_id) WHERE revoked_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX gps_consents_user_idx ON gps_consents (tenant_id, user_id, granted_at DESC)`,
    );

    for (const tabla of ['patrol_tracks', 'gps_consents']) {
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
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- patrol_tracks: sin UPDATE. Una posicion registrada no se corrige;
          -- DELETE si, porque la retencion tiene que poder borrarla.
          GRANT SELECT, INSERT, DELETE ON patrol_tracks TO sentrycore_app;
          REVOKE UPDATE ON patrol_tracks FROM sentrycore_app;
          -- gps_consents: sin DELETE. Un consentimiento no se borra, se revoca
          -- (UPDATE de revoked_at); la evidencia de que se informo tiene que
          -- sobrevivir a la revocacion.
          GRANT SELECT, INSERT, UPDATE ON gps_consents TO sentrycore_app;
          REVOKE DELETE ON gps_consents FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE gps_consents`);
    await queryRunner.query(`DROP TABLE patrol_tracks`);
  }
}
