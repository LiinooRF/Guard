import { SupervisorService } from './supervisor.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

const SUPERVISOR = 'supervisor-id';

function servicio(query: jest.Mock) {
  return new SupervisorService({ manager: { query } } as unknown as TenantContextService);
}

describe('SupervisorService', () => {
  it('un recinto NO asignado responde 403, aunque el permiso alcance', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // supervisor_sites vacio
    await expect(servicio(query).listRoutes('site-id', SUPERVISOR)).rejects.toThrow(
      'No tienes este recinto asignado',
    );
  });

  it('sin punto de cierre marcado, el ultimo de la secuencia cierra la ronda', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ present: true }]) // recinto asignado
      .mockResolvedValueOnce([]) // INSERT routes
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-3' }]);
    await servicio(query).createRoute('site-id', SUPERVISOR, {
      name: 'Nocturna',
      estimatedDurationMin: 30,
      checkpoints: [
        { checkpointId: 'cp-1' },
        { checkpointId: 'cp-2' },
        { checkpointId: 'cp-3' },
      ],
    });
    // los insert de la secuencia: el tercero (y solo el) va con is_closing_point=true
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('route_checkpoints'));
    expect(inserts.map((c) => c[1][3])).toEqual([false, false, true]);
  });

  it('dos puntos de cierre marcados es un error, no una adivinanza', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ present: true }]);
    await expect(
      servicio(query).createRoute('site-id', SUPERVISOR, {
        name: 'x',
        estimatedDurationMin: 30,
        checkpoints: [
          { checkpointId: 'cp-1', isClosingPoint: true },
          { checkpointId: 'cp-2', isClosingPoint: true },
        ],
      }),
    ).rejects.toThrow('Solo un punto puede cerrar la ronda');
  });

  it('cambiar la secuencia sube la version; los campos sueltos no', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 3 }]) // routeSite
      .mockResolvedValueOnce([{ present: true }]) // asignado
      .mockResolvedValueOnce([]); // UPDATE routes
    const r = await servicio(query).updateRoute('route-id', SUPERVISOR, { name: 'Nuevo' });
    expect(r.version).toBe(3);

    const query2 = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 3 }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([]) // DELETE secuencia
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([]); // UPDATE routes
    const r2 = await servicio(query2).updateRoute('route-id', SUPERVISOR, {
      checkpoints: [{ checkpointId: 'cp-1' }, { checkpointId: 'cp-2' }],
    });
    expect(r2.version).toBe(4);
  });

  it('la ronda congela el snapshot de puntos al asignarla', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 1 }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ user_id: 'guard-id' }]) // membresia GUARDIA
      .mockResolvedValueOnce([
        { checkpoint_id: 'cp-1' },
        { checkpoint_id: 'cp-2' },
      ]) // secuencia actual
      .mockResolvedValueOnce([]); // INSERT patrol
    const r = await servicio(query).createPatrol('route-id', SUPERVISOR, {
      guardId: 'guard-id',
      scheduledStartAt: '2026-08-04T22:00:00-04:00',
      scheduledEndAt: '2026-08-05T06:00:00-04:00',
    });
    expect(r.expectedCheckpoints).toBe(2);
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO patrols'));
    expect(insert[1][6]).toBe(JSON.stringify(['cp-1', 'cp-2']));
  });

  it('una ventana que termina antes de empezar se rechaza', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ site_id: 'site-id', version: 1 }])
      .mockResolvedValueOnce([{ present: true }]);
    await expect(
      servicio(query).createPatrol('route-id', SUPERVISOR, {
        guardId: 'guard-id',
        scheduledStartAt: '2026-08-05T06:00:00Z',
        scheduledEndAt: '2026-08-04T22:00:00Z',
      }),
    ).rejects.toThrow('La ventana termina antes de empezar');
  });
});
