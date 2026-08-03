import type { Role } from './roles';

/**
 * Catálogo único de capacidades del producto.
 *
 * Los controladores declaran capacidades, no roles. Así, incorporar una
 * capacidad o reasignarla sólo exige modificar esta matriz y no los guards.
 */
export const PERMISSIONS = [
  'account:sessions:manage',
  'platform:tenants:manage',
  'platform:metrics:read',
  'platform:branding:manage',
  'platform:support:access',
  'tenant:dashboard:read',
  'tenant:users:manage',
  'tenant:sites:manage',
  'tenant:rules:manage',
  'tenant:stats:read',
  'tenant:audit:read',
  'tenant:security:manage',
  'routes:manage',
  'shifts:manage',
  'patrols:monitor',
  'patrols:execute',
  'reports:read',
  'incidents:create',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS = {
  SUPERADMIN: [
    'account:sessions:manage',
    'platform:tenants:manage',
    'platform:metrics:read',
    'platform:branding:manage',
    'platform:support:access',
  ],
  ADMIN: [
    'account:sessions:manage',
    'tenant:dashboard:read',
    'tenant:users:manage',
    'tenant:sites:manage',
    'tenant:rules:manage',
    'tenant:stats:read',
    'tenant:audit:read',
    'tenant:security:manage',
    'reports:read',
  ],
  SUPERVISOR: [
    'account:sessions:manage',
    'tenant:dashboard:read',
    'routes:manage',
    'shifts:manage',
    'patrols:monitor',
    'reports:read',
    'incidents:create',
  ],
  GUARDIA: [
    'account:sessions:manage',
    'patrols:execute',
    'incidents:create',
  ],
} as const satisfies Record<Role, readonly Permission[]>;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission);
}
