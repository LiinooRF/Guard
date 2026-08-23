import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Afloja el bloqueo por intentos fallidos.
 *
 * Los valores originales —5 intentos, bloqueo de 5 minutos escalando hasta
 * 60— estaban pensados para un panel de oficina. En terreno castigan al
 * usuario legitimo: un guardia de noche gasta cinco intentos sin ser un
 * atacante, y una hora afuera con el turno empezado es un turno perdido.
 *
 * Se actualizan SOLO las empresas que todavia tienen los cuatro valores
 * originales, es decir, las que nunca los configuraron. A quien eligio los
 * suyos no se le toca nada: su decision manda sobre este cambio.
 */
export class AflojarBloqueoPorIntentos1726956000000 implements MigrationInterface {
  name = 'AflojarBloqueoPorIntentos1726956000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenant_auth_policies
        ALTER COLUMN max_failed_attempts SET DEFAULT 10,
        ALTER COLUMN base_lock_seconds SET DEFAULT 60,
        ALTER COLUMN max_lock_seconds SET DEFAULT 900
    `);
    await queryRunner.query(`
      UPDATE tenant_auth_policies
         SET max_failed_attempts = 10,
             base_lock_seconds = 60,
             max_lock_seconds = 900
       WHERE max_failed_attempts = 5
         AND window_seconds = 900
         AND base_lock_seconds = 300
         AND max_lock_seconds = 3600
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenant_auth_policies
        ALTER COLUMN max_failed_attempts SET DEFAULT 5,
        ALTER COLUMN base_lock_seconds SET DEFAULT 300,
        ALTER COLUMN max_lock_seconds SET DEFAULT 3600
    `);
    await queryRunner.query(`
      UPDATE tenant_auth_policies
         SET max_failed_attempts = 5,
             base_lock_seconds = 300,
             max_lock_seconds = 3600
       WHERE max_failed_attempts = 10
         AND window_seconds = 900
         AND base_lock_seconds = 60
         AND max_lock_seconds = 900
    `);
  }
}
