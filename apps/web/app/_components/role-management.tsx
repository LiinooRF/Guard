'use client';

import { FormEvent, useDeferredValue, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface PlatformTenant {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  status: 'active' | 'suspended';
  planKey: string;
  planName: string;
  userLimit: number;
  siteLimit: number;
  siteCount: number;
  userCount: number;
  monthlyPatrolCount: number;
  lastPatrolAt: string | null;
}

export interface PlatformBilling {
  tenantId: string;
  displayName: string;
  activeSiteCount: number;
  activeSupervisorCount: number;
  billableUnitCount: number;
  netAmountClp: number;
  billingMonth: string;
}

export interface TenantUser {
  id: string;
  email: string | null;
  username: string | null;
  givenName: string;
  familyName: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'GUARDIA';
  isActive: boolean;
  siteIds: string[];
}

export interface TenantSite {
  id: string;
  branchName: string;
  name: string;
  address: string;
  isActive: boolean;
  checkpointCount: number;
  supervisorCount: number;
}

export function PlatformManagement({
  tenants,
  billing,
  apiUrl,
}: {
  tenants: PlatformTenant[];
  billing: PlatformBilling[];
  apiUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('es'));
  const visibleTenants = useMemo(
    () =>
      tenants.filter((tenant) => {
        const matchesQuery =
          !deferredQuery ||
          tenant.displayName.toLocaleLowerCase('es').includes(deferredQuery) ||
          tenant.legalName.toLocaleLowerCase('es').includes(deferredQuery) ||
          tenant.slug.toLocaleLowerCase('es').includes(deferredQuery);
        return (
          matchesQuery &&
          (statusFilter === 'all' || tenant.status === statusFilter) &&
          (planFilter === 'all' || tenant.planKey === planFilter)
        );
      }),
    [deferredQuery, planFilter, statusFilter, tenants],
  );
  const totals = useMemo(
    () =>
      tenants.reduce(
        (result, tenant) => ({
          active: result.active + Number(tenant.status === 'active'),
          users: result.users + tenant.userCount,
          sites: result.sites + tenant.siteCount,
          patrols: result.patrols + tenant.monthlyPatrolCount,
        }),
        { active: 0, users: 0, sites: 0, patrols: 0 },
      ),
    [tenants],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage(null);
    const response = await apiRequest(`${apiUrl}/platform/tenants`, 'POST', {
      slug: data.get('slug'),
      legalName: data.get('legalName'),
      displayName: data.get('displayName'),
      planKey: data.get('planKey'),
      adminEmail: data.get('adminEmail'),
      adminGivenName: data.get('adminGivenName'),
      adminFamilyName: data.get('adminFamilyName'),
      adminPassword: data.get('adminPassword'),
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setMessage('Empresa y administrador creados correctamente.');
    startTransition(() => router.refresh());
  }

  async function toggle(tenant: PlatformTenant) {
    setMessage(null);
    const response = await apiRequest(
      `${apiUrl}/platform/tenants/${tenant.id}/status`,
      'PATCH',
      { status: tenant.status === 'active' ? 'suspended' : 'active' },
    );
    if (!response.ok) return setMessage(await responseMessage(response));
    startTransition(() => router.refresh());
  }

  return (
    <>
      <section className="stat-grid" id="resumen">
        <PlatformMetric label="Tenants activos" value={totals.active} detail={`${tenants.length - totals.active} suspendidos`} />
        <PlatformMetric label="Usuarios" value={totals.users} detail={`${totals.sites} recintos`} />
        <PlatformMetric label="Rondas del mes" value={totals.patrols} detail="Toda la plataforma" />
      </section>
      <div className="management-grid">
      <section className="management-card" id="alta">
        <div className="card-heading">
          <div><span className="eyebrow">Onboarding</span><h2>Nueva empresa</h2></div>
        </div>
        <form className="management-form" onSubmit={submit}>
          <label>Nombre visible<input name="displayName" required minLength={2} /></label>
          <label>Razón social<input name="legalName" required minLength={3} /></label>
          <label>Identificador URL<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="seguridad-andina" /></label>
          <label>Plan<select name="planKey"><option value="base">Base</option><option value="pro">Pro</option></select></label>
          <div className="form-divider">Administrador inicial</div>
          <label>Nombre<input name="adminGivenName" required /></label>
          <label>Apellido<input name="adminFamilyName" required /></label>
          <label>Correo<input name="adminEmail" type="email" required /></label>
          <label>Clave inicial<input name="adminPassword" type="password" minLength={12} required autoComplete="new-password" /></label>
          <button className="primary-button" disabled={pending}>Crear empresa</button>
        </form>
        {message && <p className="management-message" role="status">{message}</p>}
      </section>

      <section className="management-card" id="empresas">
        <div className="card-heading">
          <div><span className="eyebrow">Plataforma</span><h2>Empresas</h2></div>
          <span className="status-pill">{visibleTenants.length} de {tenants.length}</span>
        </div>
        <div className="tenant-filters">
          <label>
            <span>Buscar</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nombre, razón social o slug" />
          </label>
          <label>
            <span>Estado</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">Todos</option><option value="active">Activos</option><option value="suspended">Suspendidos</option>
            </select>
          </label>
          <label>
            <span>Plan</span>
            <select value={planFilter} onChange={(event) => setPlanFilter(event.target.value)}>
              <option value="all">Todos</option><option value="base">Base</option><option value="pro">Pro</option>
            </select>
          </label>
        </div>
        <div className="management-list">
          {visibleTenants.map((tenant) => {
            const nearUserLimit = tenant.userCount / tenant.userLimit >= 0.8;
            const nearSiteLimit = tenant.siteCount / tenant.siteLimit >= 0.8;
            return (
            <article className="management-row" key={tenant.id}>
              <div>
                <strong>{tenant.displayName}</strong>
                <small>{tenant.slug} · Plan {tenant.planName}</small>
                <small>{tenant.userCount}/{tenant.userLimit} usuarios · {tenant.siteCount}/{tenant.siteLimit} recintos · {tenant.monthlyPatrolCount} rondas este mes</small>
                <small>Última actividad: {formatActivity(tenant.lastPatrolAt)}</small>
                {(nearUserLimit || nearSiteLimit) ? <span className="limit-warning">Cerca del límite del plan</span> : null}
              </div>
              <span className={`state-chip ${tenant.status}`}>{tenant.status === 'active' ? 'Activa' : 'Suspendida'}</span>
              <button className="secondary-button" onClick={() => toggle(tenant)} disabled={pending}>
                {tenant.status === 'active' ? 'Suspender' : 'Reactivar'}
              </button>
            </article>
          )})}
          {!visibleTenants.length ? <div className="dashboard-empty"><strong>Sin resultados</strong><span>Ajusta la búsqueda o los filtros.</span></div> : null}
        </div>
      </section>
      </div>
      <section className="management-card management-wide" id="licencias">
        <div className="card-heading">
          <div><span className="eyebrow">Mes en curso</span><h2>Unidades facturables</h2></div>
          <span className="status-pill">{billing.reduce((sum, item) => sum + item.billableUnitCount, 0)} unidades</span>
        </div>
        <p className="section-explanation">Se cobran recintos y supervisores activos. Los guardias no generan unidades.</p>
        <div className="management-list">
          {billing.map((item) => (
            <article className="management-row billing-row" key={item.tenantId}>
              <div>
                <strong>{item.displayName}</strong>
                <small>{item.activeSiteCount} recintos + {item.activeSupervisorCount} supervisores</small>
              </div>
              <span className="billing-units">{item.billableUnitCount} unidades</span>
              <strong className="billing-amount">{formatClp(item.netAmountClp)}</strong>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function PlatformMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function formatActivity(value: string | null) {
  if (!value) return 'Sin rondas registradas';
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' }).format(new Date(value));
}

function formatClp(value: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value);
}

export function AdminManagement({
  users,
  sites,
  apiUrl,
}: {
  users: TenantUser[];
  sites: TenantSite[];
  apiUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await apiRequest(`${apiUrl}/admin/users`, 'POST', {
      givenName: data.get('givenName'),
      familyName: data.get('familyName'),
      email: data.get('email') || undefined,
      username: data.get('username') || undefined,
      role: data.get('role'),
      password: data.get('password'),
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setMessage('Usuario creado. Entrega la credencial por un canal seguro.');
    startTransition(() => router.refresh());
  }

  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await apiRequest(`${apiUrl}/admin/sites`, 'POST', {
      branchName: data.get('branchName'),
      name: data.get('name'),
      address: data.get('address'),
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setMessage('Recinto creado correctamente.');
    startTransition(() => router.refresh());
  }

  async function toggleUser(user: TenantUser) {
    const response = await apiRequest(`${apiUrl}/admin/users/${user.id}/active`, 'PATCH', {
      isActive: !user.isActive,
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    startTransition(() => router.refresh());
  }

  async function toggleSite(site: TenantSite) {
    const response = await apiRequest(`${apiUrl}/admin/sites/${site.id}/active`, 'PATCH', {
      isActive: !site.isActive,
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    startTransition(() => router.refresh());
  }

  async function assign(supervisor: TenantUser, siteId: string) {
    const assigned = !supervisor.siteIds.includes(siteId);
    const response = await apiRequest(
      `${apiUrl}/admin/users/${supervisor.id}/sites/${siteId}`,
      'PATCH',
      { assigned },
    );
    if (!response.ok) return setMessage(await responseMessage(response));
    startTransition(() => router.refresh());
  }

  return (
    <>
      {message && <p className="management-message sticky-message" role="status">{message}</p>}
      <div className="management-grid">
        <section className="management-card">
          <div className="card-heading"><div><span className="eyebrow">Personas</span><h2>Crear usuario</h2></div></div>
          <form className="management-form" onSubmit={createUser}>
            <label>Nombre<input name="givenName" required /></label>
            <label>Apellido<input name="familyName" required /></label>
            <label>Rol<select name="role"><option value="GUARDIA">Guardia</option><option value="SUPERVISOR">Supervisor</option></select></label>
            <label>Correo (opcional)<input name="email" type="email" /></label>
            <label>Usuario (si no tiene correo)<input name="username" minLength={4} /></label>
            <label>Clave inicial<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
            <button className="primary-button" disabled={pending}>Crear usuario</button>
          </form>
        </section>
        <section className="management-card">
          <div className="card-heading"><div><span className="eyebrow">Operación</span><h2>Crear recinto</h2></div></div>
          <form className="management-form" onSubmit={createSite}>
            <label>Sucursal<input name="branchName" required /></label>
            <label>Nombre del recinto<input name="name" required /></label>
            <label>Dirección<input name="address" required /></label>
            <button className="primary-button" disabled={pending}>Crear recinto</button>
          </form>
        </section>
      </div>
      <section className="management-card management-wide" id="usuarios">
        <div className="card-heading"><div><span className="eyebrow">Accesos</span><h2>Usuarios del tenant</h2></div><span className="status-pill">{users.length}</span></div>
        <div className="management-list">
          {users.map((user) => (
            <article className="management-row user-row" key={user.id}>
              <div><strong>{user.givenName} {user.familyName}</strong><small>{user.email ?? user.username} · {user.role}</small></div>
              <span className={`state-chip ${user.isActive ? 'active' : 'suspended'}`}>{user.isActive ? 'Activo' : 'Inactivo'}</span>
              {user.role !== 'ADMIN' && <button className="secondary-button" onClick={() => toggleUser(user)} disabled={pending}>{user.isActive ? 'Desactivar' : 'Activar'}</button>}
              {user.role === 'SUPERVISOR' && (
                <div className="site-assignment">
                  {sites.filter((site) => site.isActive).map((site) => (
                    <label key={site.id}>
                      <input type="checkbox" checked={user.siteIds.includes(site.id)} onChange={() => assign(user, site.id)} />
                      {site.name}
                    </label>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="management-card management-wide" id="recintos">
        <div className="card-heading"><div><span className="eyebrow">Infraestructura</span><h2>Recintos</h2></div><span className="status-pill">{sites.length}</span></div>
        <div className="management-list">
          {sites.map((site) => (
            <article className="management-row" key={site.id}>
              <div><strong>{site.name}</strong><small>{site.branchName} · {site.address}</small><small>{site.checkpointCount} puntos · {site.supervisorCount} supervisores</small></div>
              <span className={`state-chip ${site.isActive ? 'active' : 'suspended'}`}>{site.isActive ? 'Activo' : 'Inactivo'}</span>
              <button className="secondary-button" onClick={() => toggleSite(site)} disabled={pending}>{site.isActive ? 'Desactivar' : 'Activar'}</button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

async function apiRequest(url: string, method: string, body: object) {
  return fetch(url, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function responseMessage(response: Response) {
  try {
    const data = (await response.json()) as { message?: string | string[] };
    return Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'No fue posible completar la operación.';
  } catch {
    return 'No fue posible completar la operación.';
  }
}
