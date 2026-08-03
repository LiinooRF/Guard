import { computeCompliance, patrolRulesSchema } from '@voxia/shared';

import { ReportsService } from './reports.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

/** Motor de reglas sin overrides: responde los defaults del producto (#16). */
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as
    unknown as RulesService;

const ENCABEZADO = {
  id: 'patrol-id',
  status: 'completada',
  scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
  scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
  started_at: new Date('2026-07-30T22:05:00-04:00'),
  closed_at: new Date('2026-07-31T05:40:00-04:00'),
  compliance_pct: '100.00',
  tenant_name: 'Seguridad Demo SpA',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  guard_name: 'Juan Soto',
};

const PUNTOS = [
  { position: '1', id: 'cp-1', name: 'Acceso principal', kind: 'normal', is_closing_point: false },
  { position: '2', id: 'cp-2', name: 'Portería', kind: 'acceso_critico', is_closing_point: true },
];

const SITIO = {
  tenant_name: 'Seguridad Demo SpA',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
};

const esPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';

describe('ReportsService.buildPatrolReport', () => {
  it('genera un PDF real (empieza con %PDF- y tiene contenido)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ENCABEZADO]) // encabezado de la ronda
      .mockResolvedValueOnce(PUNTOS) // puntos esperados en orden efectivo
      .mockResolvedValueOnce([
        {
          checkpoint_id: 'cp-1',
          method: 'nfc',
          scanned_at_server: new Date('2026-07-30T23:10:00-04:00'),
          scanned_at_device: null,
          anomalies: [],
        },
        {
          checkpoint_id: 'cp-2',
          method: 'nfc',
          scanned_at_server: new Date('2026-07-31T05:40:00-04:00'),
          scanned_at_device: null,
          anomalies: ['fuera_de_radio_gps'],
        },
      ]); // escaneos
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    const informe = await service.buildPatrolReport('patrol-id');

    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.pdf.length).toBeGreaterThan(1000);
    expect(informe.filename).toBe('informe-ronda-patrol-id.pdf');
    expect(informe.tenantName).toBe('Seguridad Demo SpA');
    expect(informe.compliance).toMatchObject({ pct: 100, scanned: 2, expected: 2 });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('FROM patrols'), [
      'patrol-id',
    ]);
  });

  it('una ronda sin escaneos no revienta: PDF válido con 0% y todos los puntos faltantes', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ENCABEZADO])
      .mockResolvedValueOnce(PUNTOS)
      .mockResolvedValueOnce([]); // ni un escaneo
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    const informe = await service.buildPatrolReport('patrol-id');

    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.pdf.length).toBeGreaterThan(0);
    expect(informe.compliance).toMatchObject({
      pct: 0,
      scanned: 0,
      expected: 2,
      missedCheckpointIds: ['cp-1', 'cp-2'],
      belowThreshold: true,
    });
  });

  it('el cumplimiento del encabezado coincide con el calculado por computeCompliance', async () => {
    const manager = { query: jest.fn() };
    const scans = [
      {
        checkpoint_id: 'cp-1',
        method: 'nfc',
        scanned_at_server: new Date('2026-07-30T23:10:00-04:00'),
        scanned_at_device: null,
        anomalies: [],
      },
    ];
    manager.query
      .mockResolvedValueOnce([ENCABEZADO])
      .mockResolvedValueOnce(PUNTOS)
      .mockResolvedValueOnce(scans);
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    const informe = await service.buildPatrolReport('patrol-id');

    const esperado = computeCompliance(
      PUNTOS.map((p) => p.id),
      scans.map((s) => ({ checkpointId: s.checkpoint_id, anomalies: [] })),
      patrolRulesSchema.parse({}).complianceThreshold,
    );
    expect(informe.compliance).toEqual(esperado);
    expect(informe.compliance.pct).toBe(50);
  });

  it('respeta el umbral del tenant leído de RulesService, no el default', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ENCABEZADO])
      .mockResolvedValueOnce(PUNTOS)
      .mockResolvedValueOnce([
        {
          checkpoint_id: 'cp-1',
          method: 'nfc',
          scanned_at_server: new Date('2026-07-30T23:10:00-04:00'),
          scanned_at_device: null,
          anomalies: [],
        },
        {
          checkpoint_id: 'cp-2',
          method: 'nfc',
          scanned_at_server: new Date('2026-07-31T05:40:00-04:00'),
          scanned_at_device: null,
          anomalies: [],
        },
      ]);
    const reglas = {
      effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({ complianceThreshold: 100 })),
    } as unknown as RulesService;
    const service = new ReportsService({ manager } as unknown as TenantContextService, reglas);

    // 100% con umbral 100 NO queda bajo el umbral.
    const informe = await service.buildPatrolReport('patrol-id');
    expect(informe.compliance).toMatchObject({ pct: 100, belowThreshold: false });
  });

  it('la ronda inexistente lanza NotFound sin intentar dibujar nada', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]) };
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    await expect(service.buildPatrolReport('patrol-fantasma')).rejects.toThrow(
      'La ronda no existe',
    );
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});

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
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

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

  it('un periodo sin rondas genera el PDF igual, sin reventar', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([SITIO])
      .mockResolvedValueOnce([]) // sin rondas
      .mockResolvedValueOnce([]) // sin semanas
      .mockResolvedValueOnce([]); // sin rutas
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    const informe = await service.buildSiteSummary('site-id');
    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.pdf.length).toBeGreaterThan(0);
  });

  it('la sucursal inexistente lanza NotFound', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]) };
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    await expect(service.buildSiteSummary('site-fantasma')).rejects.toThrow(
      'La sucursal no existe',
    );
  });

  it('rechaza un rango invertido antes de tocar la base', async () => {
    const manager = { query: jest.fn() };
    const service = new ReportsService(
      { manager } as unknown as TenantContextService,
      sinReglas(),
    );

    await expect(
      service.buildSiteSummary('site-id', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    ).rejects.toThrow('`from` debe ser anterior a `to`');
    expect(manager.query).not.toHaveBeenCalled();
  });
});
