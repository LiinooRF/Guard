import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitacora del envio automatico del informe al cierre de la ronda (#86).
 *
 * POR QUE EXISTE LA TABLA
 * El criterio de aceptacion es "reprocesar una ronda no reenvia el informe dos
 * veces". La cola de correo ya deduplica por jobId, pero esa garantia vive en
 * Redis: si a Redis se le limpia la base, o se cambia el prefijo de las colas,
 * la idempotencia desaparece sin dejar rastro. Ademas el jefe de operaciones
 * pregunta "a quien le llego el informe de esa ronda", y eso no se responde
 * mirando una cola. Una fila por (ronda, tipo, destinatario) responde las dos
 * cosas y sobrevive a cualquier limpieza de Redis.
 *
 * ES BITACORA, NO ESTADO: se inserta y se lee, nunca se modifica ni se borra.
 * Por eso voxia_app recibe SELECT e INSERT y nada mas. Que el correo se haya
 * entregado de verdad lo sabe la cola de mail; aca queda registrado que el
 * sistema lo despacho, que es lo que hace falta para no despacharlo de nuevo.
 *
 * `kind` distingue el informe normal de la alerta bajo umbral porque son dos
 * correos distintos al mismo destinatario: el admin recibe los dos cuando la
 * ronda cierra bajo el minimo, con asuntos diferentes, y cada uno tiene que
 * poder registrarse sin pisar al otro.
 */
export class CreateReportDeliveries1725462086000 implements MigrationInterface {
  name = 'CreateReportDeliveries1725462086000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE report_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        patrol_id uuid NOT NULL,
        kind text NOT NULL
          CONSTRAINT report_deliveries_kind_check CHECK (kind IN ('informe', 'alerta')),
        -- Se guarda normalizado en minusculas desde la aplicacion: la unicidad
        -- es sobre texto y "Jefe@Cliente.cl" y "jefe@cliente.cl" son la misma
        -- casilla.
        recipient_email text NOT NULL
          CONSTRAINT report_deliveries_email_check
          CHECK (position('@' in recipient_email) > 1),
        -- Nulo cuando el destinatario es un correo fijo de las reglas (el jefe
        -- de operaciones del cliente final, que no es usuario del sistema).
        recipient_user_id uuid,
        compliance_pct numeric(5,2)
          CONSTRAINT report_deliveries_compliance_check
          CHECK (compliance_pct BETWEEN 0 AND 100),
        -- false cuando el PDF supero el maximo configurado y el correo salio
        -- con el enlace al panel en vez del adjunto.
        attached boolean NOT NULL DEFAULT true,
        queued_at timestamptz NOT NULL DEFAULT now(),
        -- La idempotencia del issue, en la base y no solo en Redis.
        UNIQUE (tenant_id, patrol_id, kind, recipient_email),
        FOREIGN KEY (tenant_id, patrol_id)
          REFERENCES patrols(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, recipient_user_id)
          REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
      )
    `);

    // El UNIQUE de arriba ya deja un indice con prefijo (tenant_id, patrol_id),
    // que es justo por donde consulta el panel: no hace falta otro.

    await queryRunner.query(`ALTER TABLE report_deliveries ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE report_deliveries FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY report_deliveries_isolation ON report_deliveries
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
          -- Sin UPDATE ni DELETE: es el registro de que el informe ya salio.
          -- Si se pudiera borrar, se podria reenviar, y la idempotencia seria
          -- una recomendacion en vez de una garantia.
          GRANT SELECT, INSERT ON report_deliveries TO voxia_app;
          REVOKE UPDATE, DELETE ON report_deliveries FROM voxia_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE report_deliveries`);
  }
}
