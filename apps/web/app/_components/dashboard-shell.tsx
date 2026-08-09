import type { CSSProperties, ReactNode } from 'react';

import { Brand } from './brand';
import { SesionViva } from './sesion-viva';
import { LogoutButton } from './logout-button';
import { PANEL_NAVIGATION, type PanelRole } from './panel-navigation';

/**
 * La marca que el shell dibuja y las variables CSS que deja caer en cascada.
 * La resuelve el SERVIDOR con `marcaDelTenant()` (`_lib/marca-del-tenant.ts`)
 * — nunca el navegador, para que no exista un instante con la marca de otro.
 */
export interface MarcaDelShell {
  commercialName: string | null;
  logoUri: string | null;
  /** `--marca-primario` y compañía; `globals.css` las lee con fallback. */
  cssVariables: Record<string, string>;
}

export function DashboardShell({
  role,
  title,
  subtitle,
  children,
  streamlined = false,
  marca,
  activeView = 'resumen',
}: {
  role: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  streamlined?: boolean;
  marca?: MarcaDelShell;
  activeView?: string;
}) {
  return (
    <main className="dashboard-shell" data-role={role} style={marca?.cssVariables as CSSProperties}>
      {/* Renueva el token antes de que venza. Va en el shell y no en cada panel
          porque el problema es de TODOS los roles: quien deja la pantalla
          abierta sin enviar nada se queda sin sesion a los 15 minutos. */}
      <SesionViva />
      <aside className="sidebar">
        <Brand compact nombre={marca?.commercialName} logoUri={marca?.logoUri} />
        {streamlined ? (
          <div className="guard-nav-note">Solo verás la tarea que debes realizar ahora.</div>
        ) : (
          <nav aria-label="Navegación principal" className="panel-navigation">
            {(PANEL_NAVIGATION[role as PanelRole] ?? []).map((group) => (
              <div className="nav-group" key={group.label}>
                <span className="nav-group-label">{group.label}</span>
                {group.items.map((item) => {
                  const active = item.view === activeView;
                  return (
                    <a
                      aria-current={active ? 'page' : undefined}
                      className={`nav-item${active ? ' active' : ''}`}
                      href={`?vista=${item.view}`}
                      key={item.view}
                    >
                      <span aria-hidden="true">{item.icon}</span> {item.label}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>
        )}
        <div className="sidebar-footer">
          <span className="avatar">{role.slice(0, 2)}</span>
          <span><strong>Sesión activa</strong><small>{role}</small></span>
        </div>
      </aside>
      <section className="dashboard-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">{role}{streamlined ? ' · Operación' : ' · Panel'}</span>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="topbar-actions">
            <span className="live-badge">● En línea</span>
            <LogoutButton />
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}
