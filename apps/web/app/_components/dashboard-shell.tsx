import type { ReactNode } from 'react';

import { Brand } from './brand';
import { LogoutButton } from './logout-button';

export function DashboardShell({
  role,
  title,
  subtitle,
  children,
  streamlined = false,
}: {
  role: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  streamlined?: boolean;
}) {
  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Brand compact />
        {streamlined ? (
          <div className="guard-nav-note">Solo verás la tarea que debes realizar ahora.</div>
        ) : (
          <nav aria-label="Navegación principal">
            <a className="nav-item active" href="#resumen"><span>⌂</span> Resumen</a>
            <a className="nav-item" href="#operacion"><span>◎</span> Operación</a>
            <a className="nav-item" href="#alertas"><span>△</span> Alertas</a>
            <a className="nav-item" href="#informes"><span>▤</span> Informes</a>
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
