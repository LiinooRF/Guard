import { DataSource, type QueryRunner } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { ConsentService } from './consent.service';

/**
 * Publicar el aviso de geolocalizacion, contra PostgreSQL de verdad y con el
 * rol de la aplicacion (`voxia_app`, sin BYPASSRLS).
 *
 * Existe porque la prueba de humo contra staging encontro que
 * `POST /consent/policies` responde 500 con las 1740 pruebas de mock en verde.
 * Ningun mock lo podia ver: lo que falla ahi no es la logica sino el permiso, la
 * politica RLS o una restriccion de la tabla, y de eso el mock no sabe nada.
 *
 * `consent_policies` es de las tablas mas amarradas del esquema —RLS con FORCE,
 * UPDATE concedido por COLUMNA (`retired_at` y nada mas), DELETE revocado, un
 * indice unico parcial de un solo vigente por empresa y una clave foranea
 * compuesta contra `memberships`— asi que hay varias formas de fallar y todas
 * se ven igual desde afuera: HTTP 500.
 */
const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

const ANDINA = 'a0000000-0000-4000-8000-000000000001';
const ADMIN_ANDINA = 'a0000000-0000-4000-8000-000000000009';

// El minimo de la tabla son 100 caracteres, y es a proposito: sin el, cualquiera
// publica "acepto el GPS" y da por cumplido el aviso previo que exige la ley.
const AVISO =
  'Aviso de geolocalizacion para la prueba de integracion. Durante el turno la ' +
  'aplicacion registra la ubicacion del dispositivo con el unico fin de dejar ' +
  'constancia de la ronda. Fuera del turno no se registra ubicacion alguna.';

describeDatabase('ConsentService.publishPolicy (RLS y permisos reales)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function comoAdmin<T>(
    operation: (service: ConsentService, runner: QueryRunner) => Promise<T>,
  ) {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [ANDINA, ADMIN_ANDINA],
      );
      const context = new TenantContextService();
      return await context.run(runner, () => {
        const audit = new AuditService(context);
        return operation(new ConsentService(context, new RulesService(context, audit), audit), runner);
      });
    } finally {
      // Rollback SIEMPRE: la prueba no deja avisos publicados en la base.
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  const actor = { sub: ADMIN_ANDINA, tenantId: ANDINA, role: 'ADMIN' as const };

  it('publica un aviso nuevo', async () => {
    const publicado = await comoAdmin((service) =>
      service.publishPolicy(actor, {
        version: 'integracion-1',
        body: AVISO,
        privacyPolicyUrl: 'https://ejemplo.test/privacidad',
      }),
    );

    expect(publicado).toMatchObject({ version: 'integracion-1' });
    expect(publicado.id).toEqual(expect.any(String));
  });

  it('retira el aviso anterior y deja UNO solo vigente', async () => {
    // Es el caso que puede chocar con `consent_policies_vigente_idx`, el indice
    // unico parcial: si el retiro del anterior no ocurriera antes del INSERT, el
    // segundo aviso reventaria por duplicado.
    const vigentes = await comoAdmin(async (service, runner) => {
      await service.publishPolicy(actor, {
        version: 'integracion-1',
        body: AVISO,
        privacyPolicyUrl: 'https://ejemplo.test/privacidad',
      });
      await service.publishPolicy(actor, {
        version: 'integracion-2',
        body: AVISO,
        privacyPolicyUrl: 'https://ejemplo.test/privacidad',
      });
      return (await runner.query(
        `SELECT version FROM consent_policies WHERE retired_at IS NULL`,
      )) as Array<{ version: string }>;
    });

    expect(vigentes.map((fila) => fila.version)).toEqual(['integracion-2']);
  });

  it('deja el rastro en la auditoria dentro de la misma transaccion', async () => {
    // `AuditService.record` se traga sus errores, pero eso NO desaborta una
    // transaccion que PostgreSQL ya marco: si el INSERT de auditoria falla, el
    // commit revienta despues con 25P02 y el usuario ve 500 sin una sola linea
    // de error en el camino. Por eso se comprueba que la fila quede escrita.
    const registros = await comoAdmin(async (service, runner) => {
      await service.publishPolicy(actor, {
        version: 'integracion-3',
        body: AVISO,
        privacyPolicyUrl: 'https://ejemplo.test/privacidad',
      });
      return (await runner.query(
        `SELECT action FROM audit_log WHERE action = 'consentimiento.aviso_publicado'`,
      )) as Array<{ action: string }>;
    });

    expect(registros).toHaveLength(1);
  });
});
