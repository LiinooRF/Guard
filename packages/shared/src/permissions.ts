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
  /**
   * Dar de alta PUNTOS de control y vincular sus etiquetas NFC (#309), en los
   * recintos asignados. Quien instala la etiqueta en la pared es el supervisor:
   * hasta ahora tenia que pedirle al ADMIN que la registrara mientras el estaba
   * parado frente al punto.
   *
   * Separado de `tenant:sites:manage` a proposito: ese permiso es del ADMIN y
   * ademas de puntos gobierna los RECINTOS enteros (alta, baja, horario habil,
   * feriados) sobre el tenant completo. Reutilizarlo le habria dado al
   * supervisor la infraestructura de toda la empresa, y los permisos se exigen
   * con Y logico, asi que una ruta no puede pedir "uno u otro": las dos puertas
   * existen por separado.
   *
   * Va con dos segmentos y sin prefijo de alcance, como sus hermanos del
   * SUPERVISOR (`routes:manage`, `shifts:manage`, `checklists:manage`): el
   * prefijo `tenant:` significa "sobre la empresa entera", y esto no lo es. El
   * rol NO basta — se filtra por `supervisor_sites` en cada metodo.
   *
   * Cubre las etiquetas sin nombrarlas por lo mismo que `routes:manage` cubre
   * `route_checkpoints`: una etiqueta no tiene vida propia (FK a `checkpoints`
   * con ON DELETE CASCADE).
   */
  'checkpoints:manage',
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
    // Los puntos y sus etiquetas NFC los da de alta quien los instala (#309).
    // NO se le agrega `tenant:sites:manage`: los recintos siguen siendo del ADMIN.
    'checkpoints:manage',
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
