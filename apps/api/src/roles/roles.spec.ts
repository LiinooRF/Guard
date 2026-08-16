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
    // #309: el supervisor administra PUNTOS y etiquetas en sus recintos...
    ['SUPERVISOR', 'checkpoints:manage', true],
    // ...pero NO los recintos. Esta fila en falso es la que prueba, de forma
    // ejecutable, que el issue se resolvio con un permiso angosto y no
    // ensanchando el ancho: `tenant:sites:manage` deja ademas crear, editar y
    // dar de baja recintos, y opera sobre el tenant entero.
    ['SUPERVISOR', 'tenant:sites:manage', false],
    // El ADMIN entra a los puntos por `tenant:sites:manage`: no necesita el
    // permiso nuevo, y darselo obligaria a que la comprobacion de recinto
    // ramificara por rol dentro del servicio — la forma que falla ABIERTA
    // cuando alguien agrega un rol o se olvida de pasar el actor.
    ['ADMIN', 'checkpoints:manage', false],
    ['GUARDIA', 'patrols:execute', true],
    ['GUARDIA', 'reports:read', false],
  ] as const)('%s / %s = %s', (role, permission, expected) => {
    expect(hasPermission(role, permission)).toBe(expected);
  });
});
