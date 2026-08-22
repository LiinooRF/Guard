import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { MailService } from '../auth/mail.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { AdminService } from './admin.service';

function service(query: jest.Mock, revokeAllSessions = jest.fn().mockResolvedValue(0)) {
  const record = jest.fn().mockResolvedValue(undefined);
  return {
    admin: new AdminService(
      { manager: { query } } as unknown as TenantContextService,
      { revokeAllSessions } as unknown as AuthService,
      {} as MailService,
      { record } as unknown as AuditService,
    ),
    revokeAllSessions,
    record,
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
      removedSiteAssignments: 0,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual(['user-1', 'Ana', 'Pérez']);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('al convertir supervisor en guardia retira sus recintos y revoca sesiones', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'user-1', role_key: 'SUPERVISOR' }])
      .mockResolvedValueOnce([{ removed: 2 }]) // DELETE supervisor_sites envuelto en SELECT
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
    expect(result.removedSiteAssignments).toBe(2);
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

describe('AdminService cuotas por plan (#100, ADR 0106)', () => {
  describe('getTenantQuota', () => {
    it('obtiene la cuota para plan Starter por defecto (15 GAM)', async () => {
      const query = jest.fn().mockResolvedValueOnce([
        {
          plan_key: 'starter',
          plan_name: 'Starter',
          user_limit: 15,
          active_guards: 3,
        },
      ]);
      const { admin } = service(query);

      const quota = await admin.getTenantQuota();
      expect(quota).toEqual({
        planKey: 'starter',
        planName: 'Starter',
        maxActiveGuards: 15,
        activeGuardsCount: 3,
        isLimitReached: false,
        isNearLimit: false,
      });
    });

    it('detecta estado cerca del límite (>=80%) y límite alcanzado (100%)', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([
          { plan_key: 'starter', plan_name: 'Starter', user_limit: 15, active_guards: 12 },
        ])
        .mockResolvedValueOnce([
          { plan_key: 'pro', plan_name: 'Pro', user_limit: 60, active_guards: 60 },
        ]);
      const { admin } = service(query);

      const nearLimit = await admin.getTenantQuota();
      expect(nearLimit.isNearLimit).toBe(true);
      expect(nearLimit.isLimitReached).toBe(false);

      const limitReached = await admin.getTenantQuota();
      expect(limitReached.isLimitReached).toBe(true);
      expect(limitReached.maxActiveGuards).toBe(60);
    });

    it('aplica cuota Enterprise de 100 GAM', async () => {
      const query = jest.fn().mockResolvedValueOnce([
        { plan_key: 'enterprise', plan_name: 'Enterprise', user_limit: 100, active_guards: 99 },
      ]);
      const { admin } = service(query);

      const quota = await admin.getTenantQuota();
      expect(quota.maxActiveGuards).toBe(100);
      expect(quota.isLimitReached).toBe(false);
      expect(quota.isNearLimit).toBe(true);
    });
  });

  describe('createUser con cuotas y credenciales', () => {
    it('crea guardia sin correo usando credencial inicial a mano', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([
          { plan_key: 'starter', plan_name: 'Starter', user_limit: 15, active_guards: 5 },
        ])
        .mockResolvedValueOnce([{ admin_create_tenant_user: 'new-user-id' }]);
      const { admin } = service(query);

      const result = await admin.createUser({
        givenName: 'Juan',
        familyName: 'Guardia',
        username: 'jguardia01',
        password: 'PasswordSegura123!',
        role: 'GUARDIA',
      });

      expect(result.invitationSent).toBe(false);
      expect(typeof result.id).toBe('string');
      expect(query.mock.calls[1]?.[0]).toContain('admin_create_tenant_user');
      expect(query.mock.calls[1]?.[1]?.[1]).toBeNull(); // email null
      expect(query.mock.calls[1]?.[1]?.[2]).toBe('jguardia01'); // username
    });

    it('bloquea creación de guardia si excede la cuota del plan con mensaje amigable', async () => {
      const query = jest.fn().mockResolvedValueOnce([
        { plan_key: 'starter', plan_name: 'Starter', user_limit: 15, active_guards: 15 },
      ]);
      const { admin } = service(query);

      await expect(
        admin.createUser({
          givenName: 'Carlos',
          familyName: 'Guardia',
          email: 'carlos@guardia.cl',
          role: 'GUARDIA',
        }),
      ).rejects.toThrow(
        'Has alcanzado el límite de 15 guardias activos para tu plan actual. Contacta a soporte para ampliar tu suscripción',
      );
    });

    it('permite crear supervisor aunque la cuota de guardias esté llena', async () => {
      const invitationMail = jest.fn().mockResolvedValue(undefined);
      const query = jest.fn()
        .mockResolvedValueOnce([{ admin_create_tenant_user: 'sup-id' }])
        .mockResolvedValueOnce([]) // issue_auth_action_token
        .mockResolvedValueOnce([{ tenant_id: 'tenant-1' }]);
      const { admin } = service(query);
      (admin as unknown as { mail: { invitation: jest.Mock } }).mail = {
        invitation: invitationMail,
      };

      const result = await admin.createUser({
        givenName: 'Jefe',
        familyName: 'Supervisor',
        email: 'supervisor@empresa.cl',
        role: 'SUPERVISOR',
      });

      expect(result.invitationSent).toBe(true);
      expect(invitationMail).toHaveBeenCalledWith(
        'supervisor@empresa.cl',
        expect.any(String),
        'tenant-1',
        expect.any(String),
      );
    });

    it('exige correo o nombre de usuario', async () => {
      const query = jest.fn();
      const { admin } = service(query);

      await expect(
        admin.createUser({
          givenName: 'Sin',
          familyName: 'Identidad',
          role: 'GUARDIA',
        }),
      ).rejects.toThrow('Debes indicar correo o nombre de usuario');
    });

    it('exige clave inicial si no tiene correo', async () => {
      const query = jest.fn();
      const { admin } = service(query);

      await expect(
        admin.createUser({
          givenName: 'Sin',
          familyName: 'Clave',
          username: 'sinclave',
          role: 'GUARDIA',
        }),
      ).rejects.toThrow('La credencial sin correo requiere una clave inicial');
    });
  });

  describe('setUserActive con cuotas', () => {
    it('bloquea activación de guardia inactivo si la cuota está llena', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([{ is_active: false, role_key: 'GUARDIA' }])
        .mockResolvedValueOnce([
          { plan_key: 'starter', plan_name: 'Starter', user_limit: 15, active_guards: 15 },
        ]);
      const { admin } = service(query);

      await expect(admin.setUserActive('guardia-1', true)).rejects.toThrow(
        'Has alcanzado el límite de 15 guardias activos para tu plan actual. Contacta a soporte para ampliar tu suscripción',
      );
    });

    it('permite reactivar guardia inactivo si hay cupo disponible', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([{ is_active: false, role_key: 'GUARDIA' }])
        .mockResolvedValueOnce([
          { plan_key: 'starter', plan_name: 'Starter', user_limit: 15, active_guards: 10 },
        ])
        .mockResolvedValueOnce([{ id: 'guardia-1' }]);
      const { admin } = service(query);

      const result = await admin.setUserActive('guardia-1', true);
      expect(result).toEqual({ id: 'guardia-1', isActive: true, revokedSessions: 0 });
    });

    it('permite desactivar guardia sin comprobar cuota', async () => {
      const query = jest.fn().mockResolvedValueOnce([{ id: 'guardia-1' }]);
      const revokeAllSessions = jest.fn().mockResolvedValue(1);
      const { admin } = service(query, revokeAllSessions);

      const result = await admin.setUserActive('guardia-1', false);
      expect(result).toEqual({ id: 'guardia-1', isActive: false, revokedSessions: 1 });
      expect(revokeAllSessions).toHaveBeenCalledWith('guardia-1');
    });
  });

  describe('updateUser con cambio de rol a guardia y cuotas', () => {
    it('bloquea conversión de supervisor a guardia si la cuota está llena', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([{ id: 'sup-1', role_key: 'SUPERVISOR', is_active: true }])
        .mockResolvedValueOnce([
          { plan_key: 'pro', plan_name: 'Pro', user_limit: 60, active_guards: 60 },
        ]);
      const { admin } = service(query);

      await expect(
        admin.updateUser('sup-1', {
          givenName: 'Marcos',
          familyName: 'Reyes',
          role: 'GUARDIA',
        }),
      ).rejects.toThrow(
        'Has alcanzado el límite de 60 guardias activos para tu plan actual. Contacta a soporte para ampliar tu suscripción',
      );
    });
  });
});

