import { DEFAULT_PATROL_RULES } from '@sentrycore/shared';
import { DataSource, type QueryRunner } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { CrashReporter } from './crash-event';
import type { CrashReportingConfig } from './crash-reporting.config';
import { CrashReportingService } from './crash-reporting.service';

const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000001';
const GUARDIA_A = 'a0000000-0000-4000-8000-000000000002';
const GUARDIA_B = 'b0000000-0000-4000-8000-000000000002';
const VERSION_PRUEBA = '225.0.0-e2e';

const REPORTER: CrashReporter = { enabled: false, send: async () => false };
const CONFIG: CrashReportingConfig = {
  driver: 'off',
  dsn: null,
  environment: 'test',
  release: 'voxia-api@test',
  timeoutMs: 20,
  maxPerUserHour: 20,
};

/**
 * Guardia contra los dos defectos que un mock no puede detectar:
 *
 * - que PostgreSQL realmente compile los regex y la agregacion anidada;
 * - que RLS siga aislando el agregado aun cuando dos tenants usan la misma
 *   version de app.
 *
 * Todo se escribe con el rol restringido dentro de una transaccion revertida.
 * La prueba solo se habilita con DATABASE_APP_TEST_URL.
 */
describeDatabase('resumen seguro de caidas (PostgreSQL + RLS)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('fusiona antes del limite, no filtra texto libre y no cruza tenants', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      await contexto(runner, TENANT_A, GUARDIA_A);
      await insertar(runner, GUARDIA_A, {
        errorName: 'JuanPerezError',
        deviceModel: 'JuanPerez123',
        androidVersion: 'Santiago -33.4489,-70.6693',
        fingerprint: '2250000000000001',
        fatal: true,
      });
      await insertar(runner, GUARDIA_A, {
        errorName: '/home/Juan/Error',
        deviceModel: 'EMP12345',
        androidVersion: '\u202e14',
        fingerprint: '2250000000000002',
        fatal: false,
      });
      await insertar(runner, GUARDIA_A, {
        appVersion: 'JuanPerez1',
        errorName: 'TypeError',
        deviceModel: 'SM-A145M',
        androidVersion: '13',
        fingerprint: '2250000000000004',
        fatal: true,
      });
      await insertar(runner, GUARDIA_A, {
        appVersion: '1.2.3-JuanPerez',
        errorName: 'TypeError',
        deviceModel: 'SM-A145M',
        androidVersion: '13',
        fingerprint: '2250000000000005',
        fatal: false,
      });

      // Misma version en B: si RLS o el WHERE se abren, el total de A sube a 3.
      await contexto(runner, TENANT_B, GUARDIA_B);
      await insertar(runner, GUARDIA_B, {
        errorName: 'TypeError',
        deviceModel: 'Pixel Fold',
        androidVersion: '14',
        fingerprint: '2250000000000003',
        fatal: true,
      });

      await contexto(runner, TENANT_A, GUARDIA_A);
      const tenantContext = new TenantContextService();
      const rules = {
        effective: jest.fn(async () => DEFAULT_PATROL_RULES),
      } as unknown as RulesService;
      const servicio = new CrashReportingService(tenantContext, rules, REPORTER, CONFIG);
      const resumen = await tenantContext.run(runner, () => servicio.resumen(1));
      const grupoPrueba = resumen.grupos.find((grupo) => grupo.appVersion === VERSION_PRUEBA);
      const versionesLibres = resumen.grupos.find(
        (grupo) => grupo.appVersion === 'Versión de app no identificada',
      );

      expect(grupoPrueba).toEqual({
        errorName: 'Error no identificado',
        appVersion: VERSION_PRUEBA,
        deviceModel: 'Modelo no identificado',
        androidVersion: 'Versión no identificada',
        total: 2,
        fatales: 1,
      });
      expect(versionesLibres).toEqual({
        errorName: 'TypeError',
        appVersion: 'Versión de app no identificada',
        deviceModel: 'SM-A145M',
        androidVersion: '13',
        total: 2,
        fatales: 1,
      });
      const serializado = JSON.stringify(resumen);
      expect(serializado).not.toContain('JuanPerezError');
      expect(serializado).not.toContain('JuanPerez123');
      expect(serializado).not.toContain('EMP12345');
      expect(serializado).not.toContain('1.2.3-JuanPerez');
      expect(serializado).not.toContain('-33.4489');
      expect(serializado).not.toContain('JuanPerez1');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});

async function contexto(
  runner: QueryRunner,
  tenantId: string,
  userId: string,
): Promise<void> {
  await runner.query(
    `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
    [tenantId, userId],
  );
}

async function insertar(
  runner: QueryRunner,
  userId: string,
  valores: {
    appVersion?: string;
    errorName: string;
    deviceModel: string;
    androidVersion: string;
    fingerprint: string;
    fatal: boolean;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO app_crash_reports (
       tenant_id, user_id, source, fatal, app_version, device_model,
       android_version, error_name, error_message, stack, fingerprint
     ) VALUES (
       app_tenant_id(), $1, 'app', $2, $3, $4, $5, $6,
       'mensaje con persona@empresa.cl', 'at /home/persona/app.js:1', $7
     )`,
    [
      userId,
      valores.fatal,
      valores.appVersion ?? VERSION_PRUEBA,
      valores.deviceModel,
      valores.androidVersion,
      valores.errorName,
      valores.fingerprint,
    ],
  );
}
