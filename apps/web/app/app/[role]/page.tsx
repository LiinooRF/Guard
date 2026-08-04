import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import {
  ConsentimientoAdmin,
  ConsentimientoTrabajador,
} from '../../_components/consentimiento-carga';
import { DashboardShell } from '../../_components/dashboard-shell';
import { GuardHome, type GuardHomeData } from '../../_components/guard-home';
import { InformesPanel } from '../../_components/informes-panel';
import { ReglasConfiguracion } from '../../_components/reglas-configuracion';
import { StatsCharts } from '../../_components/stats-charts';
import { SupervisorSchedule } from '../../_components/supervisor-schedule';
import {
  AdminManagement,
  type AuthPolicy,
  type PlatformBilling,
  type PlatformTenant,
  PlatformManagement,
  type TenantSite,
  type TenantUser,
  type SecurityEvent,
} from '../../_components/role-management';
import { SessionManagement, type UserSession } from '../../_components/session-management';
import { SiteManagement } from '../../_components/site-management';

const ROLE_CONTENT = {
  guardia: {
    role: 'GUARDIA',
  },
  supervisor: {
    role: 'SUPERVISOR',
  },
  admin: {
    role: 'ADMIN',
  },
  superadmin: {
    role: 'SUPERADMIN',
  },
} as const;

interface TenantOverview {
  scope: 'tenant' | 'assigned_sites';
  metrics: {
    sites: number;
    guards: number;
    pendingPatrols: number;
    activePatrols: number;
    completedPatrols: number;
  };
  patrols: Array<{
    id: string;
    siteName: string;
    routeName: string;
    status: string;
    scheduledStartAt: string;
  }>;
}

export default async function RoleDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>;
  // Los filtros de las graficas viven en la URL: sin esto la barra empuja el
  // parametro y nadie lo lee.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await params;
  const content = ROLE_CONTENT[role as keyof typeof ROLE_CONTENT];
  if (!content) notFound();

  if (role === 'guardia') {
    const [data, sessions] = await Promise.all([loadGuardHome(), loadSessions()]);
    const subtitle = data.hasAssignment && data.patrol
      ? `Tu turno en ${data.patrol.siteName}.`
      : 'Aquí verás tu próxima tarea cuando sea asignada.';

    return (
      <DashboardShell role={content.role} title="Mi turno" subtitle={subtitle} streamlined>
        {/* El aviso de geolocalizacion ENVUELVE el contenido del turno (#78):
            mientras la persona no lo haya leido, la puerta no renderiza nada
            mas. Registrar la ubicacion de un trabajador exige informarselo
            antes, y un aviso que se pasa de largo con la rueda del mouse no es
            aviso previo. */}
        <ConsentimientoTrabajador apiUrl={publicApiUrl()}>
          <GuardHome data={data} apiUrl={publicApiUrl()} />
          <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
        </ConsentimientoTrabajador>
      </DashboardShell>
    );
  }

  if (role === 'superadmin') {
    const [tenants, billing, sessions] = await Promise.all([
      loadPlatformTenants(),
      loadPlatformBilling(),
      loadSessions(),
    ]);
    return (
      <DashboardShell
        role={content.role}
        title="Administración de la plataforma"
        subtitle="Crea empresas, entrega su administración y controla el acceso a la plataforma."
      >
        <PlatformManagement tenants={tenants} billing={billing} apiUrl={publicApiUrl()} />
        <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
      </DashboardShell>
    );
  }

  const [overview, users, sites, sessions, authPolicy, securityEvents] = await Promise.all([
    loadTenantOverview(),
    role === 'admin' ? loadAdminUsers() : Promise.resolve([]),
    role === 'admin' ? loadAdminSites() : Promise.resolve([]),
    loadSessions(),
    role === 'admin' ? loadAuthPolicy() : Promise.resolve(defaultAuthPolicy()),
    role === 'admin' ? loadSecurityEvents() : Promise.resolve([]),
  ]);
  const isSupervisor = role === 'supervisor';

  // El contenido del panel, extraido a una constante solo para poder envolverlo
  // con el aviso cuando corresponde. No cambia nada de lo que ya habia adentro.
  const panel = (
    <>
      <section className="stat-grid" id="resumen">
        <Metric label="Recintos visibles" value={overview?.metrics.sites ?? 0} detail={isSupervisor ? 'Solo asignados' : 'Tenant completo'} />
        <Metric label="Rondas en curso" value={overview?.metrics.activePatrols ?? 0} detail={`${overview?.metrics.pendingPatrols ?? 0} pendientes`} />
        <Metric label="Guardias con rondas" value={overview?.metrics.guards ?? 0} detail="Datos actuales" />
      </section>

      <section className="activity-card" id="rondas">
        <div className="card-heading">
          <div><span className="eyebrow">Operación real</span><h2>Rondas visibles</h2></div>
          <span className="status-pill">{overview?.patrols.length ?? 0} registradas</span>
        </div>
        {overview?.patrols.length ? (
          overview.patrols.map((patrol) => (
            <div className="activity-row" key={patrol.id}>
              <time>{formatTime(patrol.scheduledStartAt)}</time>
              <span className="event-icon neutral">→</span>
              <span>
                <strong>{patrol.routeName}</strong>
                <small>{patrol.siteName}</small>
              </span>
              <b>{statusLabel(patrol.status)}</b>
            </div>
          ))
        ) : (
          <div className="dashboard-empty">
            <strong>No hay rondas visibles</strong>
            <span>
              {isSupervisor
                ? 'Solicita que un administrador te asigne un recinto.'
                : 'Las rondas aparecerán cuando se programen para un guardia.'}
            </span>
          </div>
        )}
      </section>
      {isSupervisor && <SupervisorSchedule apiUrl={publicApiUrl()} />}
      <StatsCharts role={isSupervisor ? 'SUPERVISOR' : 'ADMIN'} searchParams={searchParams} />
      <InformesPanel rondas={overview?.patrols ?? []} apiUrl={publicApiUrl()} />
      {role === 'admin' && (
        <>
          <AdminManagement
            users={users}
            sites={sites}
            authPolicy={authPolicy}
            securityEvents={securityEvents}
            apiUrl={publicApiUrl()}
          />
          <SiteManagement
            sites={sites}
            apiUrl={publicApiUrl()}
            mapTileUrl={process.env.MAP_TILE_URL ?? null}
            mapAttribution={process.env.MAP_ATTRIBUTION ?? '© OpenStreetMap contributors'}
          />
        </>
      )}
      {role === 'admin' && <ReglasConfiguracion apiUrl={publicApiUrl()} />}
      {/* Publicar el aviso y demostrar que no se registro ubicacion fuera de
          turno (#78). Solo ADMIN: es de la empresa completa, y el SUPERVISOR
          esta limitado a sus recintos asignados. */}
      {role === 'admin' && <ConsentimientoAdmin apiUrl={publicApiUrl()} />}
      <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
    </>
  );

  return (
    <DashboardShell
      role={content.role}
      title={isSupervisor ? 'Mis recintos' : 'Resumen de la empresa'}
      subtitle={
        isSupervisor
          ? 'Operación limitada a los recintos que tienes asignados.'
          : 'Datos actuales de la empresa autenticada.'
      }
    >
      {/* El SUPERVISOR tambien opera desde la app y tambien se le registra el
          recorrido, asi que le corresponde el mismo aviso previo que al guardia.
          Al ADMIN no: no se le registra ubicacion, y por eso no aparece en el
          padron que arma el servidor. */}
      {isSupervisor ? (
        <ConsentimientoTrabajador apiUrl={publicApiUrl()}>{panel}</ConsentimientoTrabajador>
      ) : (
        panel
      )}
    </DashboardShell>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function publicApiUrl() {
  return process.env.NEXT_PUBLIC_API_URL ?? '/api';
}

async function loadGuardHome(): Promise<GuardHomeData> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('voxia_access');
  if (!accessToken) return noAssignment();

  const internalApiUrl = process.env.API_INTERNAL_URL ?? publicApiUrl();
  try {
    const response = await fetch(`${internalApiUrl}/guard/home`, {
      headers: { cookie: `voxia_access=${accessToken.value}` },
      cache: 'no-store',
    });
    if (!response.ok) return noAssignment();
    return (await response.json()) as GuardHomeData;
  } catch {
    return {
      ...noAssignment(),
      message: 'No pudimos consultar tu turno. Revisa la conexión e intenta nuevamente.',
    };
  }
}

async function loadTenantOverview(): Promise<TenantOverview | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('voxia_access');
  if (!accessToken) return null;

  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL ?? publicApiUrl()}/dashboard/tenant`,
      {
        headers: { cookie: `voxia_access=${accessToken.value}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as TenantOverview;
  } catch {
    return null;
  }
}

async function authenticatedGet<T>(path: string, fallback: T): Promise<T> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('voxia_access');
  if (!accessToken) return fallback;
  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL ?? publicApiUrl()}${path}`,
      {
        headers: { cookie: `voxia_access=${accessToken.value}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function loadPlatformTenants() {
  return authenticatedGet<PlatformTenant[]>('/platform/tenants', []);
}

function loadPlatformBilling() {
  return authenticatedGet<PlatformBilling[]>('/platform/tenants/billing/current', []);
}

function loadAdminUsers() {
  return authenticatedGet<TenantUser[]>('/admin/users', []);
}

function loadAdminSites() {
  return authenticatedGet<TenantSite[]>('/admin/sites', []);
}

function loadSessions() {
  return authenticatedGet<UserSession[]>('/auth/sessions', []);
}

function loadAuthPolicy() {
  return authenticatedGet<AuthPolicy>('/admin/security/policy', defaultAuthPolicy());
}

function loadSecurityEvents() {
  return authenticatedGet<SecurityEvent[]>('/admin/security/events', []);
}

function defaultAuthPolicy(): AuthPolicy {
  return {
    maxFailedAttempts: 5,
    windowSeconds: 900,
    baseLockSeconds: 300,
    maxLockSeconds: 3600,
  };
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Santiago',
  }).format(new Date(value));
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pendiente: 'Pendiente',
    en_curso: 'En curso',
    completada: 'Completada',
    incompleta: 'Incompleta',
    vencida: 'Vencida',
  };
  return labels[status] ?? 'Sin estado';
}

function noAssignment(): GuardHomeData {
  return {
    hasAssignment: false,
    message: 'Inicia sesión como guardia para consultar una asignación real.',
    synchronization: { pendingItems: 0 },
  };
}
