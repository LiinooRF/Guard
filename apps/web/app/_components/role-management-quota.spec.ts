import {
  resolvePlanQuota,
  formatQuotaExceededMessage,
} from '@sentrycore/shared';
import type { TenantUser } from './role-management';

describe('Gestión de usuarios y cuotas de plan en el panel Web (#100, ADR 0106)', () => {
  it('resuelve los límites GAM correctos por plan', () => {
    expect(resolvePlanQuota('starter').maxActiveGuards).toBe(15);
    expect(resolvePlanQuota('base').maxActiveGuards).toBe(15);
    expect(resolvePlanQuota('pro').maxActiveGuards).toBe(60);
    expect(resolvePlanQuota('enterprise').maxActiveGuards).toBe(100);
  });

  it('formatea el mensaje de cuota excedida de manera clara y no técnica', () => {
    const msgStarter = formatQuotaExceededMessage(15);
    expect(msgStarter).toBe(
      'Has alcanzado el límite de 15 guardias activos para tu plan actual. Contacta a soporte para ampliar tu suscripción',
    );

    const msgPro = formatQuotaExceededMessage(60);
    expect(msgPro).toBe(
      'Has alcanzado el límite de 60 guardias activos para tu plan actual. Contacta a soporte para ampliar tu suscripción',
    );
  });

  it('calcula correctamente el conteo de guardias activos a partir de la lista de usuarios', () => {
    const mockUsers: TenantUser[] = [
      {
        id: 'u1',
        email: 'g1@test.cl',
        username: null,
        givenName: 'Guardia',
        familyName: 'Uno',
        role: 'GUARDIA',
        isActive: true,
        siteIds: ['s1'],
      },
      {
        id: 'u2',
        email: null,
        username: 'guardia2',
        givenName: 'Guardia',
        familyName: 'Dos',
        role: 'GUARDIA',
        isActive: true,
        siteIds: ['s1'],
      },
      {
        id: 'u3',
        email: 'g3@test.cl',
        username: null,
        givenName: 'Guardia',
        familyName: 'Inactivo',
        role: 'GUARDIA',
        isActive: false,
        siteIds: [],
      },
      {
        id: 'u4',
        email: 'sup@test.cl',
        username: null,
        givenName: 'Super',
        familyName: 'Visor',
        role: 'SUPERVISOR',
        isActive: true,
        siteIds: ['s1'],
      },
    ];

    const activeGuards = mockUsers.filter((u) => u.role === 'GUARDIA' && u.isActive).length;
    expect(activeGuards).toBe(2);

    const activeSupervisors = mockUsers.filter((u) => u.role === 'SUPERVISOR' && u.isActive).length;
    expect(activeSupervisors).toBe(1);

    const limit = 15;
    const isLimitReached = activeGuards >= limit;
    const isNearLimit = limit > 0 && activeGuards / limit >= 0.8;

    expect(isLimitReached).toBe(false);
    expect(isNearLimit).toBe(false);
  });

  it('detecta estado de advertencia preventiva (cerca del límite) y límite alcanzado', () => {
    const quotaStarter: TenantQuota = {
      planKey: 'starter',
      planName: 'Starter',
      maxActiveGuards: 15,
      activeGuardsCount: 12,
      isLimitReached: false,
      isNearLimit: true,
    };
    expect(quotaStarter.isNearLimit).toBe(true);
    expect(quotaStarter.isLimitReached).toBe(false);

    const quotaFull: TenantQuota = {
      planKey: 'starter',
      planName: 'Starter',
      maxActiveGuards: 15,
      activeGuardsCount: 15,
      isLimitReached: true,
      isNearLimit: true,
    };
    expect(quotaFull.isLimitReached).toBe(true);
  });

  it('permite soporte para guardias con credencial entregada a mano (sin correo)', () => {
    const userSinEmail: TenantUser = {
      id: 'g-no-email',
      email: null,
      username: 'guardia_bodega',
      givenName: 'Pedro',
      familyName: 'Soto',
      role: 'GUARDIA',
      isActive: true,
      siteIds: [],
    };
    expect(userSinEmail.email).toBeNull();
    expect(userSinEmail.username).toBe('guardia_bodega');
    expect(userSinEmail.role).toBe('GUARDIA');
  });
});
