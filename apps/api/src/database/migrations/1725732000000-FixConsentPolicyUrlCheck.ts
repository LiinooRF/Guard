import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Arregla el CHECK de la URL del aviso de geolocalizacion (#78).
 *
 * `1725472800000-CreateConsentPolicies.ts` lo creo asi:
 *
 *     CHECK (privacy_policy_url ~* '^https://[^[:space:]]{4,500}$')
 *
 * y **en PostgreSQL los limites `{m,n}` solo admiten valores de 0 a 255**. El
 * patron no se compila al crear la tabla —ahi solo se parsea la expresion— sino
 * la primera vez que la restriccion se EVALUA, o sea en el primer INSERT. Por
 * eso la migracion se aplico sin quejarse, los SELECT respondian 200 y
 * `POST /consent/policies` devolvia 500 con
 * `invalid regular expression: invalid repetition count(s)`.
 *
 * Consecuencia: el aviso no se podia publicar, y sin aviso publicado el guardia
 * no puede aceptar el rastreo, y sin aceptarlo `POST /guard/patrols/:id/start`
 * responde 403. Un tope mal escrito dejaba el producto sin poder iniciar rondas.
 *
 * Los 1473 tests de la API seguian verdes porque mockean `manager.query`: esta
 * restriccion vive solo dentro de PostgreSQL. La reproduccion esta en
 * `consent.integration.spec.ts`, que corre contra la base de verdad.
 *
 * El arreglo conserva la intencion original —https, sin espacios, entre 4 y 500
 * caracteres despues del esquema— pero saca el tope del regex y lo pone en un
 * `length()`, que no tiene ese limite. 508 = 8 de `https://` + los 500.
 */
export class FixConsentPolicyUrlCheck1725732000000 implements MigrationInterface {
  name = 'FixConsentPolicyUrlCheck1725732000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE consent_policies DROP CONSTRAINT IF EXISTS consent_policies_url_check`,
    );
    await queryRunner.query(`
      ALTER TABLE consent_policies
      ADD CONSTRAINT consent_policies_url_check
      CHECK (
        privacy_policy_url ~* '^https://[^[:space:]]{4,}$'
        AND length(privacy_policy_url) <= 508
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Se vuelve al patron original aunque sea el roto: una migracion reversible
    // devuelve el esquema a como estaba, no a como deberia haber estado.
    await queryRunner.query(
      `ALTER TABLE consent_policies DROP CONSTRAINT IF EXISTS consent_policies_url_check`,
    );
    await queryRunner.query(`
      ALTER TABLE consent_policies
      ADD CONSTRAINT consent_policies_url_check
      CHECK (privacy_policy_url ~* '^https://[^[:space:]]{4,500}$')
    `);
  }
}
