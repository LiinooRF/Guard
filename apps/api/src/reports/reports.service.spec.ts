import { patrolRulesSchema } from '@sentrycore/shared';

import { ReportsService } from './reports.service';
import type { BrandingService } from '../branding/branding.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

/**
 * El informe de UNA ronda se prueba en patrol-report.model.spec.ts (logica pura)
 * y patrol-report.service.spec.ts (consultas, permisos y streaming). Aca queda
 * el resumen por sucursal.
 */

/** Motor de reglas sin overrides: responde los defaults del producto (#16). */
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as
    unknown as RulesService;

const marcaDemo = () =>
  ({
    forDocuments: jest.fn().mockResolvedValue({
      displayName: 'Seguridad Demo SpA',
      logoUri: null,
      primaryColor: '#1f3b73',
      mailFromName: 'Seguridad Demo SpA',
      mailFooter: null,
    }),
  }) as unknown as BrandingService;

const SITIO = {
  tenant_name: 'Razón Social Demo Limitada',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
};

const esPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';

const armar = (manager: { query: jest.Mock }, branding = marcaDemo()) =>
  new ReportsService(
    { manager } as unknown as TenantContextService,
    sinReglas(),
    branding,
  );

describe('ReportsService.buildSiteSummary', () => {
  it('genera el resumen con gráficas y tabla del periodo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO]) // sucursal
      .mockResolvedValueOnce([
        {
          id: 'patrol-1',
          status: 'completada',
          scheduled_start_at: new Date('2026-07-06T22:00:00-04:00'),
          closed_at: new Date('2026-07-07T05:30:00-04:00'),
          compliance_pct: '90.00',
          route_name: 'Ronda nocturna',
          guard_name: 'Juan Soto',
        },
        {
          id: 'patrol-2',
          status: 'incompleta',
          scheduled_start_at: new Date('2026-07-13T22:00:00-04:00'),
          closed_at: null,
          compliance_pct: null,
          route_name: 'Ronda nocturna',
          guard_name: 'Ana Rojas',
        },
      ]) // rondas del periodo
      .mockResolvedValueOnce([
        { week_start: new Date('2026-07-06T00:00:00Z'), avg_pct: 90, patrol_count: 1 },
      ]) // promedio semanal
      .mockResolvedValueOnce([
        { route_name: 'Ronda nocturna', avg_pct: 90, patrol_count: 1 },
      ]); // promedio por ruta
    const service = armar(manager);

    const informe = await service.buildSiteSummary(
      'site-id',
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
    );

    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.pdf.length).toBeGreaterThan(1000);
    expect(informe.filename).toBe('resumen-sucursal-site-id-20260701-20260801.pdf');
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('p.site_id = $1'),
      ['site-id', new Date('2026-07-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z')],
    );
  });

  it('estampa la marca del tenant y no su razón social', async () => {
    // Mismo criterio que el informe de ronda: los dos documentos los ve el
    // mismo cliente final y no pueden mostrar marcas distintas.
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const branding = marcaDemo();
    const service = armar(manager, branding);

    await service.buildSiteSummary('site-id');

    expect(branding.forDocuments).toHaveBeenCalledTimes(1);
  });

  it('un periodo sin rondas genera el PDF igual, sin reventar', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO])
      .mockResolvedValueOnce([]) // sin rondas
      .mockResolvedValueOnce([]) // sin semanas
      .mockResolvedValueOnce([]); // sin rutas
    const service = armar(manager);

    const informe = await service.buildSiteSummary('site-id');
    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.pdf.length).toBeGreaterThan(0);
  });

  it('la sucursal inexistente lanza NotFound', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]) };
    const service = armar(manager);

    await expect(service.buildSiteSummary('site-fantasma')).rejects.toThrow(
      'La sucursal no existe',
    );
  });

  it('rechaza un rango invertido antes de tocar la base', async () => {
    const manager = { query: jest.fn() };
    const service = armar(manager);

    await expect(
      service.buildSiteSummary('site-id', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    ).rejects.toThrow('`from` debe ser anterior a `to`');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('el supervisor no descarga el resumen de un recinto ajeno', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO])
      .mockResolvedValueOnce([]); // sin asignacion en supervisor_sites
    const service = armar(manager);

    await expect(service.buildSiteSummary(
      'site-ajeno',
      undefined,
      undefined,
      { sub: 'supervisor-1', role: 'SUPERVISOR' },
    )).rejects.toThrow('No tienes este recinto asignado');
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query.mock.calls[1]?.[0]).toContain('supervisor_sites');
  });

  it('el supervisor descarga el resumen de un recinto asignado', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]) // rondas
      .mockResolvedValueOnce([]) // semanas
      .mockResolvedValueOnce([]); // rutas
    const service = armar(manager);

    const informe = await service.buildSiteSummary(
      'site-propio',
      undefined,
      undefined,
      { sub: 'supervisor-1', role: 'SUPERVISOR' },
    );
    expect(esPdf(informe.pdf)).toBe(true);
  });
});
