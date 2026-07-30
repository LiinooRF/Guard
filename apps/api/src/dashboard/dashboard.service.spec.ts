import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  it('aplica asignaciones de recinto al supervisor', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            site_count: 1,
            guard_count: 1,
            pending_patrol_count: 1,
            active_patrol_count: 0,
            completed_patrol_count: 0,
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const service = new DashboardService({ manager } as unknown as TenantContextService);

    await expect(service.getTenantOverview('supervisor-id', 'SUPERVISOR')).resolves.toMatchObject({
      scope: 'assigned_sites',
      metrics: { sites: 1 },
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('assignment.supervisor_id = $2'),
      [true, 'supervisor-id'],
    );
  });

  it('permite al admin consultar el tenant completo', async () => {
    const manager = { query: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]) };
    const service = new DashboardService({ manager } as unknown as TenantContextService);

    await expect(service.getTenantOverview('admin-id', 'ADMIN')).resolves.toMatchObject({
      scope: 'tenant',
    });
    expect(manager.query).toHaveBeenCalledWith(expect.any(String), [false, 'admin-id']);
  });
});
