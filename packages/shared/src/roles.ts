import { z } from 'zod';

/**
 * Los 4 roles de VoxIA Control.
 *
 * Rol y plataforma son ejes SEPARADOS: el rol define permisos, la plataforma es
 * consecuencia de la tarea. `SUPERVISOR` necesita desktop para armar rutas sobre
 * un mapa grande y app para supervisar en terreno; es el mismo rol con dos
 * interfaces. `GUARDIA` es el unico rol sin acceso desktop.
 *
 * Ver issue #1 (Login - 4 ROLES).
 */
export const ROLES = ['SUPERADMIN', 'ADMIN', 'SUPERVISOR', 'GUARDIA'] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export type Platform = 'app' | 'desktop';

/** Donde puede entrar cada rol. Se valida en el servidor, no solo en la interfaz. */
export const ROLE_PLATFORMS: Record<Role, readonly Platform[]> = {
  SUPERADMIN: ['desktop'],
  ADMIN: ['desktop'],
  SUPERVISOR: ['app', 'desktop'],
  GUARDIA: ['app'],
};

export function canUsePlatform(role: Role, platform: Platform): boolean {
  return ROLE_PLATFORMS[role].includes(platform);
}

/**
 * `SUPERADMIN` es un rol de PLATAFORMA, no de empresa: es el unico que cruza
 * tenants. Los otros tres quedan encerrados en el suyo. Todo acceso cruzado
 * tiene que quedar auditado (ver issue #2).
 */
export function crossesTenants(role: Role): boolean {
  return role === 'SUPERADMIN';
}

/**
 * `SUPERVISOR` esta limitado a los recintos que tiene asignados, no a todo el
 * tenant. Esa restriccion se verifica aparte del rol.
 */
export function isScopedToAssignedSites(role: Role): boolean {
  return role === 'SUPERVISOR';
}

/**
 * Acciones autorizables del producto.
 *
 * Los guards consumen este catalogo; no contienen `if (role === ...)`. Agregar
 * un permiso nuevo solo exige declararlo aca y asignarlo en ROLE_PERMISSIONS.
 * El alcance por tenant y por recinto se valida ademas del permiso.
 */
export const PERMISSIONS = [
  'platform:tenants:manage',
  'platform:metrics:read',
  'platform:branding:manage',
  'platform:support:access',
  'tenant:users:manage',
  'tenant:sites:manage',
  'tenant:rules:manage',
  'tenant:stats:read',
  'tenant:audit:read',
  'routes:manage',
  'shifts:manage',
  'patrols:monitor',
  'patrols:execute',
  'reports:read',
  'incidents:create',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/**
 * Fuente de verdad de la matriz rol x permiso.
 *
 * No hay herencia implicita entre roles: SUPERADMIN administra la plataforma,
 * pero no opera silenciosamente dentro de un tenant. El acceso de soporte es
 * un permiso explicito y cada uso debe quedar auditado.
 */
export const ROLE_PERMISSIONS = {
  SUPERADMIN: [
    'platform:tenants:manage',
    'platform:metrics:read',
    'platform:branding:manage',
    'platform:support:access',
  ],
  ADMIN: [
    'tenant:users:manage',
    'tenant:sites:manage',
    'tenant:rules:manage',
    'tenant:stats:read',
    'tenant:audit:read',
    'reports:read',
  ],
  SUPERVISOR: [
    'routes:manage',
    'shifts:manage',
    'patrols:monitor',
    'reports:read',
    'incidents:create',
  ],
  GUARDIA: ['patrols:execute', 'incidents:create'],
} as const satisfies Record<Role, readonly Permission[]>;

export function hasPermission(role: Role, permission: Permission): boolean {
  const granted: readonly Permission[] = ROLE_PERMISSIONS[role];
  return granted.includes(permission);
}
