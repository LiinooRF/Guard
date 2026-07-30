import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { DashboardShell } from '../../_components/dashboard-shell';
import { GuardHome, type GuardHomeData } from '../../_components/guard-home';
import {
  AdminManagement,
  type PlatformTenant,
  PlatformManagement,
  type TenantSite,
  type TenantUser,
} from '../../_components/role-management';

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

export default async function RoleDashboard({ params }: { params: Promise<{ role: string }> }) {
  const { role } = await params;
  const content = ROLE_CONTENT[role as keyof typeof ROLE_CONTENT];
  if (!content) notFound();

  if (role === 'guardia') {
    const data = await loadGuardHome();
    const subtitle = data.hasAssignment && data.patrol
      ? `Tu turno en ${data.patrol.siteName}.`
      : 'Aquí verás tu próxima tarea cuando sea asignada.';

    return (
      <DashboardShell role={content.role} title="Mi turno" subtitle={subtitle} streamlined>
        <GuardHome data={data} apiUrl={publicApiUrl()} />
      </DashboardShell>
    );
  }

  if (role === 'superadmin') {
    const tenants = await loadPlatformTenants();
    return (
      <DashboardShell
        role={content.role}
        title="Administración de la plataforma"
        subtitle="Crea empresas, entrega su administración y controla el acceso a la plataforma."
      >
        <PlatformManagement tenants={tenants} apiUrl={publicApiUrl()} />
      </DashboardShell>
    );
  }

  const [overview, users, sites] = await Promise.all([
    loadTenantOverview(),
    role === 'admin' ? loadAdminUsers() : Promise.resolve([]),
    role === 'admin' ? loadAdminSites() : Promise.resolve([]),
  ]);
  const isSupervisor = role === 'supervisor';

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
      <section className="stat-grid" id="resumen">
        <Metric label="Recintos visibles" value={overview?.metrics.sites ?? 0} detail={isSupervisor ? 'Solo asignados' : 'Tenant completo'} />
        <Metric label="Rondas en curso" value={overview?.metrics.activePatrols ?? 0} detail={`${overview?.metrics.pendingPatrols ?? 0} pendientes`} />
        <Metric label="Guardias con rondas" value={overview?.metrics.guards ?? 0} detail="Datos actuales" />
      </section>

      <section className="activity-card" id="operacion">
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
      {role === 'admin' && (
        <AdminManagement users={users} sites={sites} apiUrl={publicApiUrl()} />
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

function loadAdminUsers() {
  return authenticatedGet<TenantUser[]>('/admin/users', []);
}

function loadAdminSites() {
  return authenticatedGet<TenantSite[]>('/admin/sites', []);
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
