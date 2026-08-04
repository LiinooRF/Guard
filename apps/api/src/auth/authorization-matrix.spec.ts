import { METHOD_METADATA } from '@nestjs/common/constants';
import {
  hasPermission,
  ROLES,
  type Permission,
  type Role,
} from '@voxia/shared';

import { AdminController } from '../admin/admin.controller';
import { AuditController } from '../audit/audit.controller';
import { BrandingController } from '../branding/branding.controller';
import { ChecklistsController } from '../checklists/checklists.controller';
import { EventsStreamController } from '../events-stream/events-stream.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import { GuardController } from '../guard/guard.controller';
import { HealthController } from '../health/health.controller';
import { EscalationController } from '../escalation/escalation.controller';
import { AlertasRondaController } from '../escalation/alertas-ronda.controller';
import { ConsentController } from '../consent/consent.controller';
import { EnvioInformeController } from '../reports/envio-informe.controller';
import { FeatureFlagsController } from '../rules/feature-flags.controller';
import { FeatureFlagsPlatformController } from '../rules/feature-flags-platform.controller';
import { GpsPolicyController } from '../geo/gps-policy.controller';
import { ConfigAuditController } from '../audit/config-audit.controller';
import { PlatformConfigAuditController } from '../audit/platform-config-audit.controller';
import { CrashReportsController } from '../observability/crash-reports.controller';
import { PlantillasCorreoController } from '../mail/plantillas-correo.controller';
import { RegistroEnviosController } from '../mail/registro-envios.controller';
import { RegistroEnviosProveedorController } from '../mail/registro-envios-proveedor.controller';
import { ExcelExportController } from '../reports/excel-export.controller';
import { EvidenceController } from '../evidence/evidence.controller';
import { PhotoServingController } from '../evidence/photo-serving.controller';
import { GeoController } from '../geo/geo.controller';
import { PlatformController } from '../platform/platform.controller';
import { SupportAccessController } from '../platform-data/support-access.controller';
import { TenantDataController } from '../platform-data/tenant-data.controller';
import { ReportsController } from '../reports/reports.controller';
import { PlatformRulesController } from '../rules/platform-rules.controller';
import { RulesController } from '../rules/rules.controller';
import { StatsChartsController } from '../stats/stats-charts.controller';
import { PlatformOpsController } from '../platform-ops/platform-ops.controller';
import { PushController } from '../push/push.controller';
import { QrController } from '../qr/qr.controller';
import { SchedulingController } from '../scheduling/scheduling.controller';
import { SupervisorController } from '../supervisor/supervisor.controller';
import { SyncController } from '../sync/sync.controller';
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
  secured(AuthController, 'issueHandoff', ['account:sessions:manage'], ALL_ROLES),
  publicEndpoint(AuthController, 'redeemHandoff'),
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
  secured(AdminController, 'listCheckpoints', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'createCheckpoint', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'updateCheckpoint', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'setCheckpointPhoto', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'setCheckpointActive', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'listTags', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'registerTag', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'retireTag', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(AdminController, 'resolveTag', ['tenant:sites:manage'], ['ADMIN'], true),

  secured(
    DashboardController,
    'tenantOverview',
    ['tenant:dashboard:read'],
    ['ADMIN', 'SUPERVISOR'],
    true,
  ),
  secured(GuardController, 'home', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'enrollDeviceKey', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'start', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'scan', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'reportEvent', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'startShift', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'endShift', ['patrols:execute'], ['GUARDIA'], true),
  secured(GuardController, 'startVoluntaryPatrol', ['patrols:execute'], ['GUARDIA'], true),

  secured(SupervisorController, 'listSites', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'listRoutes', ['routes:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'createRoute', ['routes:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'updateRoute', ['routes:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'setRouteActive', ['routes:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'createPatrol', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'listPatrols', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'listEvents', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'listShifts', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'createShift', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'assignShift', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SupervisorController, 'onDutyNow', ['patrols:monitor'], ['SUPERVISOR'], true),

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
    'mailQueueStatus',
    ['platform:metrics:read'],
    ['SUPERADMIN'],
  ),
  secured(
    PlatformController,
    'updateStatus',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),

  secured(ReportsController, 'patrolReport', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(ReportsController, 'siteSummary', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),

  secured(EvidenceController, 'uploadPhoto', ['patrols:execute'], ['GUARDIA'], true),
  secured(EvidenceController, 'listPatrolPhotos', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(EvidenceController, 'uploadEventPhoto', ['patrols:execute'], ['GUARDIA'], true),
  secured(EvidenceController, 'listEventPhotos', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(EvidenceController, 'issuePhotoLink', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(EvidenceController, 'verifyPhotoIntegrity', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  // Los bytes de la foto los autoriza la FIRMA del enlace, no la sesion: por eso
  // vive en su propio controlador, publico y fuera del @TenantScope() del resto
  // del modulo. Ver photo-links.ts.
  publicEndpoint(PhotoServingController, 'servePhoto'),

  secured(TenantDataController, 'pendingDeletions', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(TenantDataController, 'exportTenant', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(TenantDataController, 'scheduleDeletion', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(TenantDataController, 'cancelDeletion', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(TenantDataController, 'executeDeletion', ['platform:tenants:manage'], ['SUPERADMIN']),

  secured(SupportAccessController, 'active', ['platform:support:access'], ['SUPERADMIN']),
  secured(SupportAccessController, 'open', ['platform:support:access'], ['SUPERADMIN']),
  secured(SupportAccessController, 'close', ['platform:support:access'], ['SUPERADMIN']),

  secured(BrandingController, 'theme', ['account:sessions:manage'], ALL_ROLES),
  secured(BrandingController, 'replace', ['tenant:rules:manage'], ['ADMIN'], true),

  secured(AuditController, 'listAudit', ['tenant:audit:read'], ['ADMIN'], true),
  secured(AuditController, 'auditActions', ['tenant:audit:read'], ['ADMIN'], true),
  secured(AuditController, 'statsOverview', ['tenant:stats:read'], ['ADMIN'], true),
  secured(AuditController, 'statsTrend', ['tenant:stats:read'], ['ADMIN'], true),

  secured(EscalationController, 'getPolicies', ['tenant:security:manage'], ['ADMIN'], true),
  secured(EscalationController, 'replacePolicies', ['tenant:security:manage'], ['ADMIN'], true),
  secured(EscalationController, 'acknowledge', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(EscalationController, 'falseAlarm', ['patrols:execute'], ['GUARDIA'], true),

  secured(SyncController, 'push', ['patrols:execute'], ['GUARDIA'], true),
  secured(SyncController, 'status', ['patrols:execute'], ['GUARDIA'], true),

  secured(GeoController, 'appendTrack', ['patrols:execute'], ['GUARDIA'], true),
  secured(GeoController, 'patrolTrack', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(GeoController, 'grantConsent', ['account:sessions:manage'], ALL_ROLES),
  secured(GeoController, 'revokeConsent', ['account:sessions:manage'], ALL_ROLES),
  secured(GeoController, 'consentStatus', ['account:sessions:manage'], ALL_ROLES),

  secured(SchedulingController, 'preview', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SchedulingController, 'generate', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SchedulingController, 'listPatterns', ['shifts:manage'], ['SUPERVISOR'], true),
  secured(SchedulingController, 'replacePatterns', ['shifts:manage'], ['SUPERVISOR'], true),

  secured(PushController, 'registerDevice', ['account:sessions:manage'], ALL_ROLES),
  secured(PushController, 'unregisterDevice', ['account:sessions:manage'], ALL_ROLES),

  secured(QrController, 'issueCheckpointQr', ['tenant:sites:manage'], ['ADMIN'], true),
  secured(QrController, 'siteSheet', ['tenant:sites:manage'], ['ADMIN'], true),

  secured(PlatformOpsController, 'provision', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(PlatformOpsController, 'platformMetrics', ['platform:metrics:read'], ['SUPERADMIN']),

  secured(EventsStreamController, 'stream', ['patrols:monitor'], ['SUPERVISOR'], true),

  secured(ChecklistsController, 'listTemplates', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ChecklistsController, 'getTemplate', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ChecklistsController, 'createTemplate', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ChecklistsController, 'updateTemplate', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ChecklistsController, 'setTemplateActive', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ChecklistsController, 'templateForPatrol', ['patrols:execute'], ['GUARDIA'], true),
  secured(ChecklistsController, 'submitResponses', ['patrols:execute'], ['GUARDIA'], true),

  publicEndpoint(HealthController, 'health'),
  publicEndpoint(HealthController, 'ready'),
  secured(AlertasRondaController, 'listAlerts', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(AlertasRondaController, 'attendAlert', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(ConsentController, 'currentPolicy', ['account:sessions:manage'], ALL_ROLES),
  secured(ConsentController, 'policyDetail', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ConsentController, 'policyHistory', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ConsentController, 'publishPolicy', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(ConsentController, 'roster', ['tenant:audit:read'], ['ADMIN'], true),
  secured(ConsentController, 'offShiftAudit', ['tenant:audit:read'], ['ADMIN'], true),
  secured(EnvioInformeController, 'estadoEnvio', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  publicEndpoint(FeatureFlagsController, 'catalog'),
  secured(FeatureFlagsController, 'overview', ['account:sessions:manage'], ALL_ROLES),
  secured(FeatureFlagsController, 'adminView', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(FeatureFlagsController, 'updateAdminPreferences', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(FeatureFlagsPlatformController, 'plans', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(FeatureFlagsPlatformController, 'updatePlan', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(
    FeatureFlagsPlatformController,
    'tenantFeatures',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(
    FeatureFlagsPlatformController,
    'updateTenantFeatures',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(GpsPolicyController, 'policy', ['patrols:execute'], ['GUARDIA'], true),
  secured(GpsPolicyController, 'gpsCheck', ['patrols:execute'], ['GUARDIA'], true),
  secured(GpsPolicyController, 'reportPermission', ['patrols:execute'], ['GUARDIA'], true),
  secured(GpsPolicyController, 'patrolBattery', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(GpsPolicyController, 'siteGpsCoverage', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(SyncController, 'clock', ['patrols:execute'], ['GUARDIA'], true),
  secured(SyncController, 'lateScans', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(SyncController, 'reviewLateScan', ['patrols:monitor'], ['SUPERVISOR'], true),
  secured(GuardController, 'eventAcknowledgement', ['patrols:execute'], ['GUARDIA'], true),
  secured(ConfigAuditController, 'history', ['tenant:audit:read'], ['ADMIN'], true),
  secured(ConfigAuditController, 'parameters', ['tenant:audit:read'], ['ADMIN'], true),
  secured(
    PlatformConfigAuditController,
    'platformHistory',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(
    PlatformConfigAuditController,
    'tenantHistory',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(CrashReportsController, 'reportarFalla', ['account:sessions:manage'], ALL_ROLES),
  secured(CrashReportsController, 'resumen', ['tenant:audit:read'], ['ADMIN'], true),
  secured(PlantillasCorreoController, 'verRemitente', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(PlantillasCorreoController, 'guardarRemitente', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(PlantillasCorreoController, 'vistaPrevia', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(RegistroEnviosController, 'listar', ['tenant:audit:read'], ['ADMIN'], true),
  secured(RegistroEnviosController, 'porRonda', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  // El proveedor de correo avisa el estado de entrega por webhook: no trae sesion
  // y se autentica con la firma del propio proveedor, no con un rol.
  publicEndpoint(RegistroEnviosProveedorController, 'estadoEntrega'),
  secured(ExcelExportController, 'exportarExcel', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  publicEndpoint(RulesController, 'defaults'),
  publicEndpoint(RulesController, 'catalog'),
  secured(RulesController, 'effective', ['account:sessions:manage'], ALL_ROLES),
  secured(RulesController, 'siteRules', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(RulesController, 'updateSiteRules', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(RulesController, 'checkpointRules', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(RulesController, 'updateCheckpointRules', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(PlatformRulesController, 'platformRules', ['platform:tenants:manage'], ['SUPERADMIN']),
  secured(
    PlatformRulesController,
    'updatePlatformRules',
    ['platform:tenants:manage'],
    ['SUPERADMIN'],
  ),
  secured(StatsChartsController, 'complianceBySite', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(StatsChartsController, 'evolution', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(StatsChartsController, 'missedCheckpoints', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(StatsChartsController, 'guardRanking', ['reports:read'], ['ADMIN', 'SUPERVISOR'], true),
  secured(RulesController, 'tenantRules', ['tenant:rules:manage'], ['ADMIN'], true),
  secured(RulesController, 'updateTenantRules', ['tenant:rules:manage'], ['ADMIN'], true),
] as const;

const CONTROLLERS = [
  AuthController,
  AdminController,
  DashboardController,
  GuardController,
  PlatformController,
  HealthController,
  RulesController,
  PlatformRulesController,
  StatsChartsController,
  SupervisorController,
  ReportsController,
  EvidenceController,
  ConfigAuditController,
  PlatformConfigAuditController,
  CrashReportsController,
  PlantillasCorreoController,
  RegistroEnviosController,
  RegistroEnviosProveedorController,
  ExcelExportController,
  AlertasRondaController,
  ConsentController,
  EnvioInformeController,
  FeatureFlagsController,
  FeatureFlagsPlatformController,
  GpsPolicyController,
  PhotoServingController,
  TenantDataController,
  SupportAccessController,
  AuditController,
  BrandingController,
  ChecklistsController,
  EventsStreamController,
  SchedulingController,
  QrController,
  PushController,
  PlatformOpsController,
  EscalationController,
  SyncController,
  GeoController,
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
