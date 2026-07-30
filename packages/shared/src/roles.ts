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
