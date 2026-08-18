import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import {
  ConsentimientoAdmin,
  ConsentimientoTrabajador,
} from '../../_components/consentimiento-carga';
import { CrashReportsSummary } from '../../_components/crash-reports-summary';
import { DashboardShell, type MarcaDelShell } from '../../_components/dashboard-shell';
import { EnviosPanel } from '../../_components/envios-panel';
import { FuncionesConfiguracion } from '../../_components/funciones-configuracion';
import { MarcaConfiguracion } from '../../_components/marca-configuracion';
import { marcaDelTenant } from '../../_lib/marca-del-tenant';
import { GuardHome, type GuardHomeData } from '../../_components/guard-home';
import { GuardShift } from '../../_components/guard-shift';
import { InformesPanel } from '../../_components/informes-panel';
import { LivePatrolBoard } from '../../_components/live-patrol-board';
import { ReglasConfiguracion } from '../../_components/reglas-configuracion';
import { RouteEditor, type RouteEditorSite } from '../../_components/route-editor';
import { StatsCharts } from '../../_components/stats-charts';
import { SupervisorPanel } from '../../_components/supervisor-panel';
import { SupervisorSchedule } from '../../_components/supervisor-schedule';
import { TareasTurnoEditor } from '../../_components/tareas-turno-editor';
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
import { PuntosSupervisor } from '../../_components/puntos-supervisor';
import { SessionManagement, type UserSession } from '../../_components/session-management';
import { SiteManagement } from '../../_components/site-management';
import { panelViewCopy, resolvePanelView, type PanelRole } from '../../_components/panel-navigation';

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
  const query = await searchParams;
  const content = ROLE_CONTENT[role as keyof typeof ROLE_CONTENT];
  if (!content) notFound();

  /*
   * La marca de la empresa (#117), resuelta en el servidor para TODOS los
   * roles antes del primer render: logo, nombre comercial y las variables
   * `--marca-*` que globals.css ya leia con fallback. Pedirla en el navegador
   * mostraria un instante la marca del producto — que en un white-label es el
   * cliente viendo la marca de otro.
   */
  const tema = await marcaDelTenant();
  const marca: MarcaDelShell = {
    commercialName: tema.branding.commercialName,
    logoUri: tema.branding.logoUri,
    cssVariables: tema.cssVariables,
  };

  if (role === 'guardia') {
    const siteId = firstParameter(query.siteId);
    const [data, sessions] = await Promise.all([loadGuardHome(siteId), loadSessions()]);
    const subtitle = data.hasAssignment && data.patrol
      ? `Ronda en ${data.patrol.siteName}.`
      : 'Aquí verás tu próxima ronda cuando sea asignada.';

    return (
      <DashboardShell role={content.role} title="Mi ronda" subtitle={subtitle} streamlined marca={marca}>
        {/* El aviso de geolocalizacion ENVUELVE el contenido del turno (#78):
            mientras la persona no lo haya leido, la puerta no renderiza nada
            mas. Registrar la ubicacion de un trabajador exige informarselo
            antes, y un aviso que se pasa de largo con la rueda del mouse no es
            aviso previo. */}
        <ConsentimientoTrabajador apiUrl={publicApiUrl()}>
          {/* Dos pantallas, una sola montada a la vez. GuardHome es la antesala:
              resumen del turno y el boton de iniciar. GuardShift es la ronda en
              terreno — escaneo NFC, fotos, novedades, panico, sincronizacion.
              Hasta ahora la pagina montaba SIEMPRE GuardHome, asi que con la
              ronda en curso el guardia veia un boton "Escanear punto NFC" sin
              onClick: todo el modulo de terreno existia en el repo y no lo
              alcanzaba nadie.
              No se montan las dos juntas a proposito: cada una llama a
              useGuardBridge, que abre su propio cliente del puente nativo, y dos
              handshakes compiten por los mismos mensajes de escaneo. */}
          {data.patrol && data.patrol.status !== 'pendiente' ? (
            <GuardShift data={data} apiUrl={publicApiUrl()} />
          ) : (
            <GuardHome data={data} apiUrl={publicApiUrl()} />
          )}
          <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
        </ConsentimientoTrabajador>
      </DashboardShell>
    );
  }

  if (role === 'superadmin') {
    const view = resolvePanelView('SUPERADMIN', firstParameter(query.vista));
    const copy = panelViewCopy('SUPERADMIN', view);
    const sessions = view === 'sesiones' ? await loadSessions() : [];
    const [tenants, billing] = view === 'resumen'
      ? await Promise.all([loadPlatformTenants(), loadPlatformBilling()])
      : [[], [] as PlatformBilling[]];
    return (
      <DashboardShell
        role={content.role}
        title={copy.title}
        subtitle={copy.subtitle}
        marca={marca}
        activeView={view}
      >
        {view === 'sesiones' ? (
          <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
        ) : (
          <PlatformManagement tenants={tenants} billing={billing} apiUrl={publicApiUrl()} />
        )}
      </DashboardShell>
    );
  }

  const isSupervisor = role === 'supervisor';
  const panelRole: PanelRole = isSupervisor ? 'SUPERVISOR' : 'ADMIN';
  const view = resolvePanelView(panelRole, firstParameter(query.vista));
  const copy = panelViewCopy(panelRole, view);
  const needsOverview = view === 'resumen' || (!isSupervisor && ['informes', 'envios'].includes(view));
  const needsSites = !isSupervisor && ['personas', 'recintos', 'envios'].includes(view);

  const [overview, users, sites, sessions, authPolicy, securityEvents, routeEditorSites] = await Promise.all([
    needsOverview ? loadTenantOverview() : Promise.resolve(null),
    !isSupervisor && view === 'personas' ? loadAdminUsers() : Promise.resolve([]),
    needsSites ? loadAdminSites() : Promise.resolve([]),
    view === 'sesiones' ? loadSessions() : Promise.resolve([]),
    !isSupervisor && view === 'personas' ? loadAuthPolicy() : Promise.resolve(defaultAuthPolicy()),
    !isSupervisor && view === 'personas' ? loadSecurityEvents() : Promise.resolve([]),
    isSupervisor && view === 'planificacion' ? loadRouteEditorSites() : Promise.resolve([]),
  ]);

  const resumen = (
    <div className="panel-view" data-view="resumen">
      <section className="stat-grid">
        <Metric label="Recintos visibles" value={overview?.metrics.sites ?? 0} detail={isSupervisor ? 'Solo asignados' : 'Tenant completo'} />
        <Metric label="Rondas en curso" value={overview?.metrics.activePatrols ?? 0} detail={`${overview?.metrics.pendingPatrols ?? 0} pendientes`} />
        <Metric label="Guardias con rondas" value={overview?.metrics.guards ?? 0} detail="Datos actuales" />
      </section>

      <section className="activity-card">
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
    </div>
  );

  let panel;
  if (view === 'resumen') {
    panel = resumen;
  } else if (isSupervisor && view === 'planificacion') {
    panel = (
      <div className="panel-view" data-view="planificacion">
        <SupervisorSchedule apiUrl={publicApiUrl()} />
        <RouteEditor
          sites={routeEditorSites}
          apiUrl={publicApiUrl()}
          mapTileUrl={process.env.MAP_TILE_URL ?? null}
          mapAttribution={process.env.MAP_ATTRIBUTION ?? ''}
        />
        <TareasTurnoEditor apiUrl={publicApiUrl()} />
      </div>
    );
  } else if (isSupervisor && view === 'terreno') {
    // #309. Los datos NO vienen de `GET /admin/sites` —que el supervisor no
    // puede leer— sino de `/supervisor/sites` y `/checkpoints/supervisor/...`,
    // que ya filtran por `supervisor_sites` en el servidor. Por eso el
    // componente se carga solo en el navegador y no recibe `sites` desde aca.
    panel = (
      <div className="panel-view" data-view="terreno">
        <PuntosSupervisor
          apiUrl={publicApiUrl()}
          mapTileUrl={process.env.MAP_TILE_URL ?? null}
          mapAttribution={process.env.MAP_ATTRIBUTION ?? '© OpenStreetMap contributors'}
        />
      </div>
    );
  } else if (isSupervisor && view === 'monitoreo') {
    panel = (
      <div className="panel-view" data-view="monitoreo">
        <LivePatrolBoard
          apiUrl={publicApiUrl()}
          tileUrl={process.env.MAP_TILE_URL ?? null}
          attribution={process.env.MAP_ATTRIBUTION ?? ''}
        />
      </div>
    );
  } else if (view === 'informes') {
    panel = (
      <div className="panel-view" data-view="informes">
        <StatsCharts role={panelRole} searchParams={query} />
        {isSupervisor ? (
          <SupervisorPanel searchParams={query} />
        ) : (
          <InformesPanel rondas={overview?.patrols ?? []} apiUrl={publicApiUrl()} />
        )}
      </div>
    );
  } else if (!isSupervisor && view === 'personas') {
    panel = (
      <div className="panel-view" data-view="personas">
        <AdminManagement
          users={users}
          sites={sites}
          authPolicy={authPolicy}
          securityEvents={securityEvents}
          apiUrl={publicApiUrl()}
        />
      </div>
    );
  } else if (!isSupervisor && view === 'recintos') {
    panel = (
      <div className="panel-view" data-view="recintos">
        <SiteManagement
          sites={sites}
          apiUrl={publicApiUrl()}
          mapTileUrl={process.env.MAP_TILE_URL ?? null}
          mapAttribution={process.env.MAP_ATTRIBUTION ?? '© OpenStreetMap contributors'}
        />
      </div>
    );
  } else if (!isSupervisor && view === 'reglas') {
    panel = (
      <div className="panel-view" data-view="reglas">
        <FuncionesConfiguracion apiUrl={publicApiUrl()} />
        <ReglasConfiguracion apiUrl={publicApiUrl()} />
      </div>
    );
  } else if (!isSupervisor && view === 'marca') {
    panel = (
      <div className="panel-view" data-view="marca">
        <MarcaConfiguracion apiUrl={publicApiUrl()} />
      </div>
    );
  } else if (!isSupervisor && view === 'envios') {
    panel = (
      <div className="panel-view" data-view="envios">
        <EnviosPanel
          searchParams={query}
          recintos={sites}
          rondas={overview?.patrols ?? []}
        />
      </div>
    );
  } else if (!isSupervisor && view === 'cumplimiento') {
    panel = <div className="panel-view" data-view="cumplimiento"><ConsentimientoAdmin apiUrl={publicApiUrl()} /></div>;
  } else if (!isSupervisor && view === 'diagnostico') {
    panel = (
      <div className="panel-view" data-view="diagnostico">
        <CrashReportsSummary apiUrl={publicApiUrl()} />
      </div>
    );
  } else if (isSupervisor && view === 'consentimiento') {
    panel = (
      <div className="panel-view" data-view="consentimiento">
        <section className="activity-card">
          <div className="card-heading">
            <div><span className="eyebrow">Privacidad en terreno</span><h2>Cómo usamos tu ubicación</h2></div>
          </div>
          <p>
            La aplicación registra ubicación únicamente durante una ronda activa. Si la empresa
            publica un aviso nuevo, tendrás que leerlo y aceptarlo antes de continuar trabajando.
          </p>
          <div className="dashboard-empty">
            <strong>Tu aviso está al día</strong>
            <span>Cuando cambie, esta pantalla bloqueará la operación hasta que revises la nueva versión.</span>
          </div>
        </section>
      </div>
    );
  } else {
    panel = <div className="panel-view" data-view="sesiones"><SessionManagement sessions={sessions} apiUrl={publicApiUrl()} /></div>;
  }

  return (
    <DashboardShell
      role={content.role}
      title={copy.title}
      subtitle={copy.subtitle}
      marca={marca}
      activeView={view}
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

function firstParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

async function loadGuardHome(siteId?: string): Promise<GuardHomeData> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('sentrycore_access');
  if (!accessToken) return noAssignment();

  const internalApiUrl = process.env.API_INTERNAL_URL ?? publicApiUrl();
  try {
    const url = siteId
      ? `${internalApiUrl}/guard/home?siteId=${encodeURIComponent(siteId)}`
      : `${internalApiUrl}/guard/home`;
    const response = await fetch(url, {
      headers: { cookie: `sentrycore_access=${accessToken.value}` },
      cache: 'no-store',
    });
    if (!response.ok) return noAssignment();
    return (await response.json()) as GuardHomeData;
  } catch {
    return {
      ...noAssignment(),
      message: 'No pudimos consultar tu ronda. Revisa la conexión e intenta nuevamente.',
    };
  }
}

async function loadTenantOverview(): Promise<TenantOverview | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('sentrycore_access');
  if (!accessToken) return null;

  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL ?? publicApiUrl()}/dashboard/tenant`,
      {
        headers: { cookie: `sentrycore_access=${accessToken.value}` },
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
  const accessToken = cookieStore.get('sentrycore_access');
  if (!accessToken) return fallback;
  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL ?? publicApiUrl()}${path}`,
      {
        headers: { cookie: `sentrycore_access=${accessToken.value}` },
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

function loadRouteEditorSites() {
  return authenticatedGet<RouteEditorSite[]>('/supervisor/route-editor/sites', []);
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
