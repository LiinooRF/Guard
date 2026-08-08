import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deja los UID de NFC ya guardados en la misma forma que produce la app.
 *
 * El alta guardaba `input.uid.trim()` mientras el movil manda el UID sin
 * separadores y en mayusculas. Una etiqueta dada de alta como `04:AA:BB:CC`
 * jamas coincidia con su escaneo — y el fallo solo aparecia con un guardia
 * parado frente al punto, porque el alta respondia 201 y el panel la mostraba
 * vinculada.
 *
 * **Solo `tech = 'nfc'`.** El UID de un QR es base32 con prefijo
 * (`VXQ-ZE7OSH...`); quitarle los caracteres no hexadecimales lo destruiria.
 *
 * Si dos filas normalizan al MISMO uid, el indice unico `tags_active_uid_uniq`
 * aborta esta migracion. Eso no es un accidente que haya que sortear: significa
 * que la misma etiqueta fisica esta dada de alta dos veces con formatos
 * distintos, y hay que mirar cual de los dos puntos es el bueno antes de seguir.
 */
export class NormalizarUidNfc1726002000000 implements MigrationInterface {
  name = 'NormalizarUidNfc1726002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tags
         SET uid = upper(regexp_replace(uid, '[^0-9a-fA-F]', '', 'g'))
       WHERE tech = 'nfc'
         AND uid <> upper(regexp_replace(uid, '[^0-9a-fA-F]', '', 'g'))
    `);
  }

  public async down(): Promise<void> {
    // No hay vuelta atras posible: el formato original (con dos puntos, con
    // guiones, en minusculas) no se puede reconstruir del normalizado. Y
    // tampoco haria falta: el formato viejo es el que no funcionaba.
  }
}
