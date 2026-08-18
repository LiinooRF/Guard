import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitacora de sincronizacion offline. Ver issue #14.
 *
 * Las rondas ocurren en subterraneos y perimetros SIN señal: el dispositivo
 * acumula operaciones y las manda en lote al recuperar red. La idempotencia
 * pieza por pieza ya existia (scans.client_scan_id, field_events.client_event_id);
 * lo que falta es la del LOTE. Una fila por (empresa, guardia, client_id) hace
 * que reenviar la cola completa —lo que hace un telefono al que se le corto el
 * POST a medio camino— no reprocese ni duplique nada.
 *
 * queued_at_device y synced_at_server van SEPARADOS a proposito: su diferencia
 * es cuanto tiempo estuvo el guardia sin señal, que es la metrica que el
 * supervisor necesita ("este recinto deja al guardia incomunicado 40 minutos en
 * el subterraneo"). Un solo timestamp no responde eso.
 *
 * `status` es el veredicto de la PRIMERA llegada y no se reescribe: el reenvio
 * suma `attempts` y conserva synced_at_server, porque si esa marca se corriera
 * con cada reintento la metrica de tiempo sin señal quedaria falseada.
 *
 * `server_id` no lleva FK a proposito: apunta a scans o a field_events segun
 * `kind`, y ademas debe sobrevivir al borrado de la ronda — la bitacora explica
 * que paso con la cola del dispositivo aunque el dato de destino ya no exista.
 */
export class CreateSyncLog1724425200000 implements MigrationInterface {
  name = 'CreateSyncLog1724425200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_operations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        -- Lo genera el dispositivo al ENCOLAR, no el servidor al recibir.
        client_id uuid NOT NULL,
        kind text NOT NULL
          CONSTRAINT sync_operations_kind_check CHECK (kind IN ('scan', 'event')),
        status text NOT NULL
          CONSTRAINT sync_operations_status_check
          CHECK (status IN ('aplicado', 'duplicado', 'rechazado')),
        reason text,
        server_id uuid,
        attempts integer NOT NULL DEFAULT 1
          CONSTRAINT sync_operations_attempts_check CHECK (attempts >= 1),
        queued_at_device timestamptz NOT NULL,
        synced_at_server timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        -- El corazon de la idempotencia del lote: el mismo client_id del mismo
        -- guardia es UNA operacion, lleguen los envios que lleguen.
        UNIQUE (tenant_id, guard_id, client_id),
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        -- Un rechazo SIN motivo no le sirve a nadie: el guardia tiene que poder
        -- ver por que su operacion no entro. Y al reves: si entro, no hay motivo.
        CONSTRAINT sync_operations_reason_check
          CHECK ((status = 'rechazado') = (reason IS NOT NULL)),
        CONSTRAINT sync_operations_reason_length_check
          CHECK (reason IS NULL OR length(reason) <= 500),
        -- Lo rechazado no escribio nada: no puede apuntar a una fila de destino.
        CONSTRAINT sync_operations_server_id_check
          CHECK (server_id IS NULL OR status <> 'rechazado')
      )
    `);

    // Sostiene syncStatus: la ventana de 24h de un guardia y su ultima sincronizacion.
    await queryRunner.query(
      `CREATE INDEX sync_operations_guard_idx
       ON sync_operations (tenant_id, guard_id, synced_at_server DESC)`,
    );
    // "Que se esta rechazando" es la pregunta de observabilidad del supervisor.
    await queryRunner.query(
      `CREATE INDEX sync_operations_rejected_idx
       ON sync_operations (tenant_id, synced_at_server DESC)
       WHERE status = 'rechazado'`,
    );

    await queryRunner.query(`ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY sync_operations_isolation ON sync_operations
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
          -- UPDATE es solo para sumar attempts en un reenvio. Sin DELETE: la
          -- bitacora es la prueba de que la cola del guardia llego, y borrarla
          -- es exactamente lo que haria quien quiere tapar una ronda perdida.
          GRANT SELECT, INSERT, UPDATE ON sync_operations TO sentrycore_app;
          REVOKE DELETE ON sync_operations FROM sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE sync_operations`);
  }
}
