import type { AuthService } from '../auth/auth.service';
import type { MailService } from '../auth/mail.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { AdminService } from './admin.service';

function service(query: jest.Mock, revokeAllSessions = jest.fn().mockResolvedValue(0)) {
  return {
    admin: new AdminService(
      { manager: { query } } as unknown as TenantContextService,
      { revokeAllSessions } as unknown as AuthService,
      {} as MailService,
    ),
    revokeAllSessions,
  };
}

describe('AdminService usuarios', () => {
  it('edita nombre sin revocar sesiones cuando el rol no cambia', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'user-1', role_key: 'GUARDIA' }])
      .mockResolvedValueOnce([{ id: 'user-1', given_name: 'Ana', family_name: 'Pérez' }]);
    const { admin, revokeAllSessions } = service(query);

    await expect(admin.updateUser('user-1', {
      givenName: '  Ana  ',
      familyName: '  Pérez ',
      role: 'GUARDIA',
    })).resolves.toEqual({
      id: 'user-1',
      givenName: 'Ana',
      familyName: 'Pérez',
      role: 'GUARDIA',
      revokedSessions: 0,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual(['user-1', 'Ana', 'Pérez']);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('al convertir supervisor en guardia retira sus recintos y revoca sesiones', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'user-1', role_key: 'SUPERVISOR' }])
      .mockResolvedValueOnce([]) // DELETE supervisor_sites
      .mockResolvedValueOnce([]) // UPDATE membership
      .mockResolvedValueOnce([{ id: 'user-1', given_name: 'Ana', family_name: 'Pérez' }]);
    const revokeAllSessions = jest.fn().mockResolvedValue(3);
    const { admin } = service(query, revokeAllSessions);

    const result = await admin.updateUser('user-1', {
      givenName: 'Ana',
      familyName: 'Pérez',
      role: 'GUARDIA',
    });

    expect(query.mock.calls[1]?.[0]).toContain('DELETE FROM supervisor_sites');
    expect(query.mock.calls[2]?.[0]).toContain('UPDATE memberships');
    expect(revokeAllSessions).toHaveBeenCalledWith('user-1');
    expect(result.revokedSessions).toBe(3);
  });

  it('al convertir guardia en supervisor conserva integridad y revoca sesiones', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'user-1', role_key: 'GUARDIA' }])
      .mockResolvedValueOnce([]) // UPDATE membership
      .mockResolvedValueOnce([{ id: 'user-1', given_name: 'Ana', family_name: 'Pérez' }]);
    const { admin, revokeAllSessions } = service(query);

    await admin.updateUser('user-1', {
      givenName: 'Ana',
      familyName: 'Pérez',
      role: 'SUPERVISOR',
    });

    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM supervisor_sites'))).toBe(false);
    expect(query.mock.calls[1]?.[1]).toEqual(['user-1', 'SUPERVISOR']);
    expect(revokeAllSessions).toHaveBeenCalledWith('user-1');
  });

  it('no permite editar al ADMIN del tenant', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { admin } = service(query);

    await expect(admin.updateUser('admin-1', {
      givenName: 'Admin',
      familyName: 'Tenant',
      role: 'SUPERVISOR',
    })).rejects.toThrow('Usuario administrable no encontrado');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
