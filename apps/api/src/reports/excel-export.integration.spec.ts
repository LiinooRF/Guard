import { ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';
import { DataSource, type QueryRunner } from 'typeorm';

import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { ExcelExportService, type AlcanceExportacion } from './excel-export.service';

const appUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appUrl ? describe : describe.skip;

/**
 * La exportacion contra el esquema REAL y contra RLS.
 *
 * Existe por dos huecos concretos, los dos con precedente en este repo:
 *
 * 1. **Ningun motor habia parseado las tres consultas.** Los tests con mock
 *    fijan el texto del SQL, que es util para revisarlo contra la migracion,
 *    pero un mock no sabe si `to_char(... AT TIME ZONE ...)` compila ni si
 *    `jsonb_array_length` existe. Los dos bugs que llegaron a staging con CI en
 *    verde eran exactamente eso.
 * 2. **No habia prueba de aislamiento entre tenants del endpoint.** Que las
 *    tablas tengan RLS no prueba que ESTA consulta la respete: alcanza un JOIN
 *    contra una tabla sin politica para abrir un boquete. CLAUDE.md, «Como
 *    verificar tu trabajo», punto 3.
 *
 * La autorizacion por rol (los 4) se prueba en `excel-export.controller.spec.ts`
 * corriendo el AuthGuard: es del guard, no de la base, y no debe depender de
 * que haya PostgreSQL levantado.
 *
 * Todo ocurre dentro de una transaccion que se revierte: el seed de desarrollo
 * queda como estaba.
 */

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000001';

const ADMIN_A = 'a0000000-0000-4000-8000-000000000009';
const SUPERVISOR_A = 'a0000000-0000-4000-8000-000000000008';
const GUARDIA_A = 'a0000000-0000-4000-8000-000000000002';
const GUARDIA_B = 'b0000000-0000-4000-8000-000000000002';

const SITE_A = 'a0000000-0000-4000-8000-000000000003';
const CHECKPOINT_A = 'a0000000-0000-4000-8000-000000000004';
const PATROL_A = 'a0000000-0000-4000-8000-000000000007';
const PATROL_B = 'b0000000-0000-4000-8000-000000000007';

/** Recinto que el SUPERVISOR de la empresa A NO tiene asignado. */
const SITE_AJENO = 'a0000000-0000-4000-8000-0000000000a1';
const ROUTE_AJENA = 'a0000000-0000-4000-8000-0000000000a2';
const PATROL_AJENA = 'a0000000-0000-4000-8000-0000000000a3';

const REGLAS = { ...patrolRulesSchema.parse({}), excelExportMaxRows: 50_000 };

/**
 * La cascada de reglas se resuelve en su propio test; aca solo hace falta el
 * tope de filas. Lo que se prueba en este archivo es el SQL y RLS.
 */
const reglasStub = () =>
  ({ effective: jest.fn().mockResolvedValue(REGLAS) }) as unknown as RulesService;

describeDatabase('exportacion a Excel (esquema real y RLS)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appUrl, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function enTenant<T>(
    tenantId: string,
    userId: string,
    operacion: (servicio: ExcelExportService, runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [tenantId, userId],
      );
      const contexto = new TenantContextService();
      return await contexto.run(runner, () => {
        const reglas = reglasStub();
        const servicio = new ExcelExportService(
          contexto,
          reglas,
          new BrandingService(contexto),
          new SupervisorService(contexto, reglas),
        );
        return operacion(servicio, runner);
      });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  /** Un escaneo y una novedad para que las tres hojas traigan filas de verdad. */
  async function sembrarActividad(runner: QueryRunner): Promise<void> {
    await runner.query(
      `INSERT INTO scans (tenant_id, patrol_id, checkpoint_id, method, client_scan_id,
                          scanned_at_device, anomalies)
       VALUES (app_tenant_id(), $1, $2, 'nfc', gen_random_uuid(), now(), '["sin_fix_gps"]'::jsonb)`,
      [PATROL_A, CHECKPOINT_A],
    );
    await runner.query(
      `INSERT INTO field_events (tenant_id, site_id, patrol_id, guard_id, criticality,
                                 text, client_event_id, reported_at_device)
       VALUES (app_tenant_id(), $1, $2, $3, 'media', 'Portón lateral sin candado',
               gen_random_uuid(), now())`,
      [SITE_A, PATROL_A, GUARDIA_A],
    );
  }

  /** Recinto + ruta + ronda que el supervisor de A no tiene asignados. */
  async function sembrarRecintoAjeno(runner: QueryRunner): Promise<void> {
    await runner.query(
      `INSERT INTO sites (id, tenant_id, branch_name, name, address, timezone)
       VALUES ($1, app_tenant_id(), 'Sucursal isla', 'Recinto no asignado',
               'Dirección de prueba', 'Pacific/Easter')`,
      [SITE_AJENO],
    );
    await runner.query(
      `INSERT INTO routes (id, tenant_id, site_id, name, estimated_duration_min)
       VALUES ($1, app_tenant_id(), $2, 'Ronda isla', 30)`,
      [ROUTE_AJENA, SITE_AJENO],
    );
    await runner.query(
      `INSERT INTO patrols (id, tenant_id, site_id, route_id, guard_id,
                            scheduled_start_at, scheduled_end_at, expected_checkpoint_ids)
       VALUES ($1, app_tenant_id(), $2, $3, $4,
               now() - INTERVAL '2 hours', now() + INTERVAL '2 hours', '[]'::jsonb)`,
      [PATROL_AJENA, SITE_AJENO, ROUTE_AJENA, GUARDIA_A],
    );
  }

  /** Todo lo escrito en las tres hojas de DATOS (sin la portada), como texto. */
  function contenidoDeDatos(hojas: readonly unknown[]): string {
    return JSON.stringify(hojas.slice(1));
  }

  const ADMIN: AlcanceExportacion = { userId: ADMIN_A, role: 'ADMIN' };
  const SUPERVISOR: AlcanceExportacion = { userId: SUPERVISOR_A, role: 'SUPERVISOR' };

  it('las tres consultas corren en PostgreSQL y traen las filas del tenant', async () => {
    // Si una columna no existiera o faltara un parentesis, esto lanza aca y no
    // en el primer informe que pida un cliente.
    const libro = await enTenant(TENANT_A, ADMIN_A, async (servicio, runner) => {
      await sembrarActividad(runner);
      return servicio.construir({}, ADMIN);
    });

    expect(libro.conteos.rondas).toBeGreaterThan(0);
    expect(libro.conteos.escaneos).toBeGreaterThan(0);
    expect(libro.conteos.novedades).toBeGreaterThan(0);
    expect(contenidoDeDatos(libro.hojas)).toContain(PATROL_A);
  });

  it('el tenant A no ve ni una fila del tenant B en ninguna de las tres hojas', async () => {
    const libroA = await enTenant(TENANT_A, ADMIN_A, async (servicio, runner) => {
      await sembrarActividad(runner);
      return servicio.construir({}, ADMIN);
    });

    const datosA = contenidoDeDatos(libroA.hojas);
    expect(datosA).toContain(PATROL_A);
    expect(datosA).not.toContain(PATROL_B);
    expect(datosA).not.toContain(TENANT_B);
  });

  it('y el tenant B tampoco ve nada del tenant A', async () => {
    // El rol de la sesion solo decide si se aplica el filtro de supervisor;
    // quien autoriza el endpoint es el guard. Lo que se prueba aca es RLS.
    const libroB = await enTenant(TENANT_B, GUARDIA_B, (servicio) =>
      servicio.construir({}, { userId: GUARDIA_B, role: 'ADMIN' }),
    );

    const datosB = contenidoDeDatos(libroB.hojas);
    expect(datosB).toContain(PATROL_B);
    expect(datosB).not.toContain(PATROL_A);
    expect(datosB).not.toContain(TENANT_A);
  });

  it('el SUPERVISOR solo ve los recintos que tiene asignados', async () => {
    const { admin, supervisor } = await enTenant(
      TENANT_A,
      SUPERVISOR_A,
      async (servicio, runner) => {
        await sembrarRecintoAjeno(runner);
        return {
          supervisor: await servicio.construir({}, SUPERVISOR),
          admin: await servicio.construir({}, ADMIN),
        };
      },
    );

    // El ADMIN del tenant ve las dos rondas; el SUPERVISOR, solo la de su
    // recinto. Si el filtro se apagara, las dos listas serian iguales.
    expect(contenidoDeDatos(admin.hojas)).toContain(PATROL_AJENA);
    expect(contenidoDeDatos(supervisor.hojas)).toContain(PATROL_A);
    expect(contenidoDeDatos(supervisor.hojas)).not.toContain(PATROL_AJENA);
  });

  it('al SUPERVISOR que pide un recinto ajeno le responde 403, no una planilla vacia', async () => {
    await expect(
      enTenant(TENANT_A, SUPERVISOR_A, async (servicio, runner) => {
        await sembrarRecintoAjeno(runner);
        return servicio.construir({ siteId: SITE_AJENO }, SUPERVISOR);
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('con recintos en zonas distintas la portada no elige una al azar', async () => {
    // El recinto sembrado esta en Pacific/Easter y el del seed en
    // America/Santiago: dos husos reales en el mismo tenant, que es el caso
    // chileno normal.
    const libro = await enTenant(TENANT_A, ADMIN_A, async (servicio, runner) => {
      await sembrarRecintoAjeno(runner);
      return servicio.construir({}, ADMIN);
    });

    const portada = JSON.stringify(libro.hojas[0]!.filas);
    expect(portada).toContain('varias');
    expect(portada).toContain('Pacific/Easter');
    expect(portada).toContain('America/Santiago');
  });

  it('filtrar por recinto, sucursal y guardia no rompe ninguna de las tres consultas', async () => {
    const libro = await enTenant(TENANT_A, ADMIN_A, async (servicio, runner) => {
      await sembrarActividad(runner);
      return servicio.construir(
        {
          siteId: SITE_A,
          branchName: 'Casa matriz',
          guardId: GUARDIA_A,
          from: hoyMenos(7),
          to: hoyMenos(0),
        },
        ADMIN,
      );
    });

    expect(libro.conteos.rondas).toBeGreaterThan(0);
    expect(contenidoDeDatos(libro.hojas)).not.toContain(PATROL_B);
  });
});

/** Dia calendario UTC, que es la unidad que acepta el endpoint. */
function hoyMenos(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
}
