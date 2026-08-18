import { AuditService } from './audit.service';
import { StatsService } from './stats.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import { patrolRulesSchema } from '@sentrycore/shared';

const ctx = (query: jest.Mock) => ({ manager: { query } }) as unknown as TenantContextService;
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as unknown as RulesService;

describe('AuditService', () => {
  it('un fallo de auditoria NO voltea la operacion que la origino', async () => {
    const query = jest.fn().mockRejectedValue(new Error('tabla caida'));
    const service = new AuditService(ctx(query));

    // No lanza: el usuario ya se creo y revertirlo seria peor que el hueco.
    await expect(
      service.record({
        actorId: 'admin-1',
        actorLabel: 'Ana Admin',
        action: 'usuario.creado',
        entityType: 'user',
      }),
    ).resolves.toBeUndefined();
  });

  it('registra actor por id Y por etiqueta, para sobrevivir al borrado del usuario', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AuditService(ctx(query)).record({
      actorId: 'admin-1',
      actorLabel: 'Ana Admin',
      action: 'reglas.modificadas',
      entityType: 'tenant_rules',
      summary: 'complianceThreshold 70 -> 90',
    });
    const [, valores] = query.mock.calls[0];
    expect(valores[0]).toBe('admin-1');
    expect(valores[1]).toBe('Ana Admin');
    expect(valores[5]).toContain('70 -> 90');
  });

  it('los filtros se aplican como parametros, no concatenados', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AuditService(ctx(query)).list({
      actorId: 'admin-1',
      action: 'usuario.creado',
      limit: 50,
    });
    const [sql, valores] = query.mock.calls[0];
    expect(sql).toContain('actor_id = $1');
    expect(sql).toContain('action = $2');
    expect(valores).toEqual(['admin-1', 'usuario.creado', 50]);
  });

  it('el limite se topa en 500 aunque pidan mas', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AuditService(ctx(query)).list({ limit: 100000 });
    expect(query.mock.calls[0][1]).toEqual([500]);
  });
});

describe('StatsService', () => {
  it('excluye las rondas voluntarias del cumplimiento', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ rondas: '10', completadas: '8', incompletas: '2',
                               vencidas: '0', cumplimiento: '84.5', bajo_umbral: '2' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new StatsService(ctx(query), sinReglas());

    const r = await service.overview({});
    expect(r.global.compliancePct).toBe(84.5);
    expect(r.threshold).toBe(70);
    // las tres consultas filtran las voluntarias
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('is_voluntary');
    }
  });

  it('el ranking parte por el PEOR recinto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ rondas: '0', completadas: '0', incompletas: '0',
                               vencidas: '0', cumplimiento: null, bajo_umbral: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 's1', name: 'Bodega Sur', branch_name: 'Sur', rondas: '12', cumplimiento: '41.0' },
        { id: 's2', name: 'Planta Norte', branch_name: 'Norte', rondas: '20', cumplimiento: '88.0' },
      ]);
    const r = await new StatsService(ctx(query), sinReglas()).overview({});
    expect(r.worstSites[0]?.siteName).toBe('Bodega Sur');
    expect(query.mock.calls[2][0]).toContain('ORDER BY avg(p.compliance_pct)');
  });

  it('la tendencia agrupa por semana en SQL, no en el navegador', async () => {
    const query = jest.fn().mockResolvedValue([
      { semana: new Date('2026-07-27'), rondas: '14', cumplimiento: '77.5' },
    ]);
    const r = await new StatsService(ctx(query), sinReglas()).trend({}, 'Norte');
    expect(query.mock.calls[0][0]).toContain("date_trunc('week'");
    expect(query.mock.calls[0][1][2]).toBe('Norte');
    expect(r[0]?.compliancePct).toBe(77.5);
  });
});
