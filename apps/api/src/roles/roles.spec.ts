import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  crossesTenants,
  hasPermission,
  isScopedToAssignedSites,
  type Permission,
} from '@voxia/shared';

describe('matriz RBAC', () => {
  it('solo SUPERADMIN cruza tenants', () => {
    expect(ROLES.filter(crossesTenants)).toEqual(['SUPERADMIN']);
  });

  it('solo SUPERVISOR requiere alcance adicional por recinto', () => {
    expect(ROLES.filter(isScopedToAssignedSites)).toEqual(['SUPERVISOR']);
  });

  it('mantiene todos los permisos declarados asignados a al menos un rol', () => {
    const assigned = new Set<Permission>(
      ROLES.flatMap((role) => [...ROLE_PERMISSIONS[role]]),
    );

    expect([...assigned].sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each([
    ['SUPERADMIN', 'platform:tenants:manage', true],
    ['SUPERADMIN', 'tenant:users:manage', false],
    ['ADMIN', 'tenant:rules:manage', true],
    ['ADMIN', 'routes:manage', false],
    ['SUPERVISOR', 'patrols:monitor', true],
    ['SUPERVISOR', 'tenant:sites:manage', false],
    ['GUARDIA', 'patrols:execute', true],
    ['GUARDIA', 'reports:read', false],
  ] as const)('%s / %s = %s', (role, permission, expected) => {
    expect(hasPermission(role, permission)).toBe(expected);
  });
});
