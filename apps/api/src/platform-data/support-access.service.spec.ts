import { SupportAccessService } from './support-access.service';
import type { DataSource } from 'typeorm';

const ds = (query: jest.Mock) => ({ query }) as unknown as DataSource;
const SUPER = 'super-1';

describe('SupportAccessService', () => {
  it('quien no es SUPERADMIN no abre accesos, aunque llegue al endpoint', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // sin platform_membership
    await expect(
      new SupportAccessService(ds(query)).open('otro-user', {
        tenantId: 't1',
        reason: 'revisar un incidente reportado',
      }),
    ).rejects.toThrow('Solo el SUPERADMIN abre accesos de soporte');
  });

  it('el motivo es obligatorio y sustantivo: no vale "ok"', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(
      new SupportAccessService(ds(query)).open(SUPER, { tenantId: 't1', reason: 'ok' }),
    ).rejects.toThrow('El motivo debe explicar el acceso');
  });

  it('la ventana se topa en 8 horas aunque pidan mas', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([]) // sin acceso abierto
      .mockResolvedValueOnce([{ id: 't1', name: 'Andina' }])
      .mockResolvedValueOnce([{ id: 'acc-1', started_at: new Date(), expires_at: new Date() }]);
    await new SupportAccessService(ds(query)).open(SUPER, {
      tenantId: 't1',
      reason: 'investigar por que no llegan las alertas',
      minutes: 99999,
    });
    const insert = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO support_access_log'));
    expect(insert[1][3]).toBe(480); // 8 horas
  });

  it('no se abren dos ventanas a la misma empresa', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 'acc-previa' }]);
    await expect(
      new SupportAccessService(ds(query)).open(SUPER, {
        tenantId: 't1',
        reason: 'seguimiento del caso anterior',
      }),
    ).rejects.toThrow('Ya tienes un acceso de soporte abierto');
  });

  it('resolve exige vigencia: vencido o cerrado no resuelve', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(
      new SupportAccessService(ds(query)).resolve('acc-1', SUPER),
    ).resolves.toBeNull();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('ended_at IS NULL');
    expect(sql).toContain('expires_at > now()');
  });

  it('resolve devuelve el tenant de la ventana vigente', async () => {
    const query = jest.fn().mockResolvedValue([{ tenant_id: 't1' }]);
    await expect(
      new SupportAccessService(ds(query)).resolve('acc-1', SUPER),
    ).resolves.toBe('t1');
  });

  it('cerrar un acceso ajeno o inexistente no hace nada silencioso', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([]);
    await expect(
      new SupportAccessService(ds(query)).close(SUPER, 'acc-ajeno'),
    ).rejects.toThrow('No hay un acceso abierto con ese id');
  });
});
