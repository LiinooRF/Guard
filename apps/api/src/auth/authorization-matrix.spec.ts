import { METHOD_METADATA } from '@nestjs/common/constants';
import {
  hasPermission,
  ROLES,
  type Permission,
  type Role,
} from '@voxia/shared';

import { AdminController } from '../admin/admin.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import { GuardController } from '../guard/guard.controller';
import { HealthController } from '../health/health.controller';
import { PlatformController } from '../platform/platform.controller';
import { RulesController } from '../rules/rules.controller';
import { AuthController } from './auth.controller';
import { IS_PUBLIC } from './decorators/public.decorator';
import { REQUIRED_PERMISSIONS } from './decorators/permissions.decorator';
import { REQUIRES_TENANT } from './decorators/tenant-scope.decorator';

type ControllerType = abstract new (...args: never[]) => unknown;

interface EndpointAuthorization {
  controller: ControllerType;
  handler: string;
  permissions?: readonly Permission[];
  roles: readonly Role[];
  tenant: boolean;
  public?: boolean;
}

const ALL_ROLES = [...ROLES];
const TENANT_ROLES = ['ADMIN', 'SUPERVISOR', 'GUARDIA'] as const;

/**
 * Inventario exhaustivo: un método HTTP nuevo que no se agregue aquí hace
 * fallar el test. Esta tabla, junto con ROLE_PERMISSIONS, es la fuente de
 * verdad ejecutable de rol × endpoint.
 */
const ENDPOINT_AUTHORIZATION: readonly EndpointAuthorization[] = [
  publicEndpoint(AuthController, 'login'),
  publicEndpoint(AuthController, 'logout'),
  publicEndpoint(AuthController, 'refresh'),
  publicEndpoint(AuthController, 'requestPasswordReset'),
  publicEndpoint(AuthController, 'completePasswordReset'),
  publicEndpoint(AuthController, 'completeInvitation'),
  secured(AuthController, 'session', ['account:sessions:manage'], ALL_ROLES),
  secured(AuthController, 'sessions', ['account:sessions:manage'], ALL_ROLES),
  secured(AuthController, 'revokeSession', ['account:sessions:manage'], ALL_ROLES),
  secured(AuthController, 'revokeAllSessions', ['account:sessions:manage'], ALL_ROLES),

  secured(AdminController, 'listUsers', ['tenant:users:manage'], ['ADMIN'], true),
  secured(AdminController, 'getAuthPolicy', ['tenant:security:manage'], ['ADMIN'], true),
  secured(AdminController, 'updateAuthPolicy', ['tenant:security:manage'], ['ADMIN'], true),
  secured(AdminController, 'securityEvents', ['tenant:security:manage'], ['ADMIN'], true),
  secured(AdminController, 'createUser', ['tenant:users:manage'], ['ADMIN'], true),
  secured(AdminController, 'setUserActive', ['tenant:users:manage'], ['ADMIN'], true),
  secured(AdminController, 'revokeUserSessions', ['tenant:users:manage'], ['ADMIN'], true),
  secured(AdminController, 'listSites', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'createSite', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'setSiteActive', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(
    AdminController,
    'setSupervisorSite',
    ['tenant:users:manage', 'tenant:sites:manage'],
    ['ADMIN'],
    true,
  ),

  secured(
    DashboardController,
    'tenantOverview',
    ['tenant:dashboard:read'],
    ['ADMIN', 'SUPERVISOR'],
    true,
  ),
  secured(GuardController, 'home', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'start', ['patrols:execute'], ['GUARDIA'], true),

  secured(
    PlatformController,
    'list',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(
    PlatformController,
    'create',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(
    PlatformController,
    'billing',
    ['platform:metrics:read'],
    ['SUPERADMIN'],
  ),
  secured(
    PlatformController,
    'updateStatus',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),

  publicEndpoint(HealthController, 'health'),
  publicEndpoint(HealthController, 'ready'),
  publicEndpoint(RulesController, 'defaults'),
] as const;

const CONTROLLERS = [
  AuthController,
  AdminController,
  DashboardController,
  GuardController,
  PlatformController,
  HealthController,
  RulesController,
] as const;

describe('matriz de autorización de endpoints', () => {
  it('incluye todos los métodos HTTP, sin endpoints implícitos', () => {
    const discovered = CONTROLLERS.flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((handler) => handler !== 'constructor')
        .filter((handler) => {
          const method = controller.prototype[handler as keyof typeof controller.prototype];
          return typeof method === 'function' && Reflect.hasMetadata(METHOD_METADATA, method);
        })
        .map((handler) => endpointKey(controller, handler)),
    ).sort();
    const declared = ENDPOINT_AUTHORIZATION.map(({ controller, handler }) =>
      endpointKey(controller, handler),
    ).sort();

    expect(declared).toEqual(discovered);
  });

  it.each(ENDPOINT_AUTHORIZATION)(
    '$controller.name.$handler declara exactamente su política',
    ({ controller, handler, permissions, roles, tenant, public: isPublic }) => {
      const method = controller.prototype[handler as keyof typeof controller.prototype];
      const targets = [method, controller];
      const actualPublic = overriddenMetadata<boolean>(IS_PUBLIC, targets) ?? false;
      const actualPermissions =
        overriddenMetadata<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];
      const actualTenant = overriddenMetadata<boolean>(REQUIRES_TENANT, targets) ?? false;
      const allowedRoles = ROLES.filter((role) =>
        actualPermissions.every((permission) => hasPermission(role, permission)),
      );

      expect(actualPublic).toBe(isPublic ?? false);
      expect(actualPermissions).toEqual(permissions ?? []);
      expect(actualTenant).toBe(tenant);
      expect(isPublic ? ALL_ROLES : allowedRoles).toEqual(roles);
      if (!isPublic) expect(actualPermissions.length).toBeGreaterThan(0);
    },
  );

  it('mantiene a SUPERADMIN fuera del contexto tenant y al resto dentro', () => {
    expect(TENANT_ROLES).not.toContain('SUPERADMIN');
    for (const endpoint of ENDPOINT_AUTHORIZATION.filter(({ tenant }) => tenant)) {
      expect(endpoint.roles.every((role) => TENANT_ROLES.includes(role as never))).toBe(true);
    }
  });
});

function publicEndpoint(
  controller: ControllerType,
  handler: string,
): EndpointAuthorization {
  return { controller, handler, roles: ALL_ROLES, tenant: false, public: true };
}

function secured(
  controller: ControllerType,
  handler: string,
  permissions: readonly Permission[],
  roles: readonly Role[],
  tenant = false,
): EndpointAuthorization {
  return { controller, handler, permissions, roles, tenant };
}

function endpointKey(controller: ControllerType, handler: string): string {
  return `${controller.name}.${handler}`;
}

function overriddenMetadata<T>(key: string, targets: readonly unknown[]): T | undefined {
  for (const target of targets) {
    const value = Reflect.getMetadata(key, target as object) as T | undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}
