import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baja el intervalo de muestreo de la traza de 60 a 30 segundos.
 *
 * El default vive en `rules.ts`, asi que quien nunca configuro el parametro
 * hereda 30 sin que esta migracion haga nada. El problema son los que tienen
 * `gpsTrackIntervalSeconds: 60` GUARDADO como override: el valor anterior por
 * defecto, escrito en la base sin que nadie lo eligiera —basta con abrir el
 * panel de reglas y guardar para que el formulario persista todos los campos
 * visibles—. Esos quedarian en 60 para siempre, que es justo lo que se
 * cambio.
 *
 * POR QUE HABIA QUE BAJARLO. Con un punto por minuto, dos puntos de control
 * que el guardia recorre en menos de un minuto caen entre muestras: el
 * recorrido los une con una recta que no paso por ningun lado y en el mapa se
 * ve un salto. Se detecto en terreno repitiendo la misma ronda con dos
 * telefonos distintos.
 *
 * SE BORRA LA CLAVE, NO SE ESCRIBE 30. Quitar el override devuelve el
 * parametro a "heredado", que es lo que era antes de que el formulario lo
 * escribiera. Si mañana el default vuelve a moverse, estas empresas lo
 * siguen; escribirles un 30 las dejaria ancladas de nuevo.
 *
 * Solo se toca el valor 60 EXACTO. Quien eligio 45, 90 o 300 tenia una razon
 * —bateria, telefonos viejos, un cliente que pidio menos registro— y su
 * decision manda sobre este cambio.
 */
export class TrazaCada30Segundos1727042400000 implements MigrationInterface {
  name = 'TrazaCada30Segundos1727042400000';

  private static readonly TABLAS = ['platform_rules', 'tenant_rules', 'site_rules'] as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tabla of TrazaCada30Segundos1727042400000.TABLAS) {
      await queryRunner.query(`
        UPDATE ${tabla}
           SET overrides = overrides - 'gpsTrackIntervalSeconds'
         WHERE overrides -> 'gpsTrackIntervalSeconds' = '60'::jsonb
      `);
    }
  }

  /**
   * La vuelta atras restituye el 60 explicito SOLO donde ahora no hay valor:
   * es lo mismo que heredaban antes del cambio. No se distingue de una empresa
   * que nunca lo configuro, y esa es la unica ambiguedad posible; escribir 60
   * de mas es preferible a dejar en 30 a quien venia de 60 si el default se
   * revierte junto con esta migracion.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabla of TrazaCada30Segundos1727042400000.TABLAS) {
      await queryRunner.query(`
        UPDATE ${tabla}
           SET overrides = overrides || '{"gpsTrackIntervalSeconds": 60}'::jsonb
         WHERE overrides -> 'gpsTrackIntervalSeconds' IS NULL
      `);
    }
  }
}
