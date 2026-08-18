import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sanea cualquier UID de etiqueta NFC cargado con separadores (dos puntos,
 * guiones, espacios) o en minúsculas después del alta de puntos o importación.
 */
export class NormalizarTagsUidNfc1726002010000 implements MigrationInterface {
  name = 'NormalizarTagsUidNfc1726002010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tags
         SET uid = upper(regexp_replace(uid, '[^0-9a-fA-F]', '', 'g'))
       WHERE tech = 'nfc'
         AND uid <> upper(regexp_replace(uid, '[^0-9a-fA-F]', '', 'g'))
    `);
  }

  public async down(): Promise<void> {
  }
}
