import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tercer motivo para la marca de despacho atendido: dominio no despachable (#86).
 *
 * QUE CAMBIA Y POR QUE
 * --------------------
 * `report_dispatch_attempts.reason` admitia dos motivos: 'envio_desactivado' y
 * 'sin_destinatarios'. Falta el que aparece todos los dias en staging: la
 * empresa SI tiene destinatarios, pero todos caen en un dominio al que no se le
 * escribe. Las cuentas demo usan `@demo-andina.test`, y `.test` esta reservado
 * por RFC 6761: no resuelve en ningun lado y cada correo es un rebote duro, que
 * es la metrica con la que un proveedor suspende una cuenta nueva.
 *
 * POR QUE NO ALCANZABA CON REUSAR 'sin_destinatarios'
 * ---------------------------------------------------
 * El motivo existe para responder "por que no le llego el informe de esa ronda"
 * sin adivinar, y los dos casos se arreglan al reves:
 *
 *   sin_destinatarios      -> la empresa se creo sin admin con correo. Se
 *                             arregla dandole un correo de verdad.
 *   dominio_no_despachable -> la empresa es una demo. Se arregla NO cargandole
 *                             mas direcciones, que es lo contrario.
 *
 * Con un solo motivo, el operador de turno "arregla" el tenant demo agregandole
 * mas direcciones `@demo-andina.test`, que es exactamente el rebote que estamos
 * evitando. El costo de distinguirlos es esta migracion de dos sentencias.
 *
 * NO CREA NINGUNA TABLA, ASI QUE NO HAY RLS QUE AGREGAR. `report_dispatch_attempts`
 * ya viene con ENABLE + FORCE ROW LEVEL SECURITY y su politica que falla cerrada
 * desde 1725472900000-CreateReportDispatchBacklog, y esa migracion tampoco le
 * dio UPDATE ni DELETE al rol de la aplicacion. Un CHECK mas amplio no toca nada
 * de eso: sigue siendo bitacora, sigue aislada por tenant.
 *
 * EL CHECK Y `MotivoAtendido` SON UN SOLO CONTRATO. Si alguien suma un motivo en
 * reports/envio-informe.service.ts sin pasar por aca, ningun test con mock lo
 * ve: revienta el INSERT en produccion, y encima en el camino de "no habia nada
 * que mandar", que es el que nadie mira hasta que el barrido queda en loop.
 */
export class AllowSuppressedDispatchReason1725822000000 implements MigrationInterface {
  name = 'AllowSuppressedDispatchReason1725822000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE report_dispatch_attempts
      DROP CONSTRAINT IF EXISTS report_dispatch_attempts_reason_check
    `);
    await queryRunner.query(`
      ALTER TABLE report_dispatch_attempts
      ADD CONSTRAINT report_dispatch_attempts_reason_check
      CHECK (reason IN ('envio_desactivado', 'sin_destinatarios', 'dominio_no_despachable'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Las marcas ya escritas con el motivo nuevo se CONVIERTEN, no se borran.
    // Borrarlas devolveria esas rondas al barrido, que volveria a despachar el
    // informe a las direcciones de prueba: revertir la distincion no puede
    // revivir el rebote que la distincion existe para evitar. 'sin_destinatarios'
    // dice menos, pero no dice nada falso: no habia a quien despacharle.
    //
    // El UPDATE corre con el rol de migraciones, que no es el de la aplicacion:
    // a sentrycore_app la migracion original le revoco UPDATE a proposito.
    await queryRunner.query(`
      UPDATE report_dispatch_attempts
      SET reason = 'sin_destinatarios'
      WHERE reason = 'dominio_no_despachable'
    `);
    await queryRunner.query(`
      ALTER TABLE report_dispatch_attempts
      DROP CONSTRAINT IF EXISTS report_dispatch_attempts_reason_check
    `);
    await queryRunner.query(`
      ALTER TABLE report_dispatch_attempts
      ADD CONSTRAINT report_dispatch_attempts_reason_check
      CHECK (reason IN ('envio_desactivado', 'sin_destinatarios'))
    `);
  }
}
