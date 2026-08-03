import { GuardService } from './guard.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

describe('GuardService', () => {
  it('indica claramente cuando el guardia no tiene turno', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new GuardService({ manager } as unknown as TenantContextService);

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: false,
      message: 'No tienes un turno asignado en este momento.',
    });
  });

  it('devuelve la ronda asignada sin datos de otros guardias', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'patrol-id',
          status: 'pendiente',
          scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
          scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
          started_at: null,
          site_name: 'Recinto demostración',
          route_name: 'Ronda nocturna demo',
          estimated_duration_min: 30,
          checkpoints: [
            { id: 'checkpoint-id', name: 'Acceso', position: 1, isClosingPoint: true },
          ],
        },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService);

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: true,
      patrol: {
        id: 'patrol-id',
        completedCheckpointCount: 0,
        checkpoints: [{ name: 'Acceso' }],
      },
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('p.guard_id = $1'), [
      'guard-id',
    ]);
  });

  it('inicia únicamente una ronda pendiente asignada al guardia autenticado', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        { id: 'patrol-id', status: 'en_curso', started_at: new Date() },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService);

    await expect(service.startPatrol('patrol-id', 'guard-id')).resolves.toMatchObject({
      status: 'en_curso',
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pendiente'"), [
      'patrol-id',
      'guard-id',
    ]);
  });
});
