import { z } from 'zod';

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
  /**
   * Armar las TAREAS del turno (#265): que revisar, en que punto, a que hora y
   * si exige foto. Es del SUPERVISOR por decision de producto (8-ago-2026):
   * quien conoce el terreno arma la tarea, y esta acotado a sus recintos
   * asignados igual que las rutas — el rol no basta, se filtra por
   * supervisor_sites.
   *
   * Separado de `tenant:rules:manage` a proposito: ese permiso es del ADMIN y
   * gobierna la cascada de reglas de toda la empresa. Reutilizarlo aqui habria
   * dado al supervisor la configuracion entera del tenant.
   */
  'checklists:manage',
  'patrols:monitor',
  'patrols:execute',
  'reports:read',
  'incidents:create',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
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
    // Las tareas del turno las arma quien conoce el terreno (#265).
    'checklists:manage',
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
