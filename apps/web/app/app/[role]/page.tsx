import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import {
  ConsentimientoAdmin,
  ConsentimientoTrabajador,
} from '../../_components/consentimiento-carga';
import { DashboardShell, type MarcaDelShell } from '../../_components/dashboard-shell';
import { EnviosPanel } from '../../_components/envios-panel';
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
    const [data, sessions] = await Promise.all([loadGuardHome(), loadSessions()]);
    const subtitle = data.hasAssignment && data.patrol
      ? `Tu turno en ${data.patrol.siteName}.`
      : 'Aquí verás tu próxima tarea cuando sea asignada.';

    return (
      <DashboardShell role={content.role} title="Mi turno" subtitle={subtitle} streamlined marca={marca}>
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
        marca={marca}
      >
        <PlatformManagement tenants={tenants} billing={billing} apiUrl={publicApiUrl()} />
        <SessionManagement sessions={sessions} apiUrl={publicApiUrl()} />
      </DashboardShell>
    );
  }

  const [overview, users, sites, sessions, authPolicy, securityEvents, routeEditorSites] = await Promise.all([
    loadTenantOverview(),
    role === 'admin' ? loadAdminUsers() : Promise.resolve([]),
    role === 'admin' ? loadAdminSites() : Promise.resolve([]),
    loadSessions(),
    role === 'admin' ? loadAuthPolicy() : Promise.resolve(defaultAuthPolicy()),
    role === 'admin' ? loadSecurityEvents() : Promise.resolve([]),
    role === 'supervisor' ? loadRouteEditorSites() : Promise.resolve([]),
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
      {isSupervisor && (
        <LivePatrolBoard
          apiUrl={publicApiUrl()}
          tileUrl={process.env.MAP_TILE_URL ?? null}
          attribution={process.env.MAP_ATTRIBUTION ?? ''}
        />
      )}
      <StatsCharts role={isSupervisor ? 'SUPERVISOR' : 'ADMIN'} searchParams={searchParams} />
      {isSupervisor && <RouteEditor
        sites={routeEditorSites}
        apiUrl={publicApiUrl()}
        mapTileUrl={process.env.MAP_TILE_URL ?? null}
        mapAttribution={process.env.MAP_ATTRIBUTION ?? ''}
      />}
      {/* Editor de tareas del turno (#265): "ir a las 11, a cierto punto, y
          tomar una imagen al refrigerador". Va junto al editor de rutas porque
          es la otra mitad de lo mismo — la ruta dice por donde pasa el guardia y
          esto dice que hace cuando llega.

          Carga su propio catalogo desde el navegador en vez de recibirlo por
          props: necesita `timezone` por recinto, que es lo unico que le da
          sentido a la hora de una tarea, y el catalogo del editor de rutas no lo
          trae. Ver `/checklists/supervisor/sites`. */}
      {isSupervisor && <TareasTurnoEditor apiUrl={publicApiUrl()} />}
      {/* Al SUPERVISOR se le REEMPLAZA el panel de informes generico, no se le
          suma otro (#99). El de arriba se alimenta de `/dashboard/tenant`, que
          mezcla las rondas de todos sus recintos sin poder elegir; el del panel
          pide por recinto y con verificacion de asignacion en el servidor. Dos
          listas de informes en la misma pantalla, una filtrable y otra no, es
          una invitacion a leer la equivocada.

          Va DESPUES de StatsCharts porque no pinta su propia barra de filtros:
          lee los mismos `?desde=&hasta=&recinto=&sucursal=` que esa barra ya
          escribe. Dos periodos distintos en la misma pantalla es la forma segura
          de comparar dos cortes creyendo que son el mismo. */}
      {isSupervisor ? (
        <SupervisorPanel searchParams={searchParams} />
      ) : (
        <InformesPanel rondas={overview?.patrols ?? []} apiUrl={publicApiUrl()} />
      )}
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
      {/* La marca de la empresa (#117). Solo ADMIN: el PUT exige
          tenant:rules:manage, y la marca es una decision de la empresa, no de
          un recinto. */}
      {role === 'admin' && (
        <section className="activity-card" id="marca">
          <div className="card-heading">
            <div>
              <span className="eyebrow">White-label</span>
              <h2>Marca de la empresa</h2>
            </div>
          </div>
          <p>
            Logo, colores y nombre con los que tu equipo ve el sistema — también en el teléfono
            del guardia, en los informes y en los correos. Se aplica al guardar, sin despliegue.
          </p>
          <MarcaConfiguracion apiUrl={publicApiUrl()} />
        </section>
      )}
      {/* Vista de envios de correo para soporte (#221): si el informe salio y si
          llego. Solo ADMIN, igual que el endpoint que consulta
          (`tenant:audit:read`): el listado incluye invitaciones y
          recuperaciones de clave de toda la empresa, no solo informes de ronda.
          Los recintos y las rondas se le pasan ya cargados —la pagina ya los
          pidio para AdminManagement y para InformesPanel— para no repetir dos
          consultas en el mismo render. */}
      {role === 'admin' && (
        <EnviosPanel
          searchParams={searchParams}
          recintos={sites}
          rondas={overview?.patrols ?? []}
        />
      )}
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
      marca={marca}
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
