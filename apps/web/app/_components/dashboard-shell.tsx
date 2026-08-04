import type { ReactNode } from 'react';

import { Brand } from './brand';
import { LogoutButton } from './logout-button';

const ROLE_NAVIGATION: Record<string, Array<{ href: string; icon: string; label: string }>> = {
  SUPERADMIN: [
    { href: '#resumen', icon: '⌂', label: 'Resumen' },
    { href: '#empresas', icon: '▦', label: 'Empresas' },
    { href: '#licencias', icon: '$', label: 'Licencias' },
    { href: '#alta', icon: '+', label: 'Nueva empresa' },
    { href: '#sesiones', icon: '◉', label: 'Sesiones' },
  ],
  ADMIN: [
    { href: '#resumen', icon: '⌂', label: 'Resumen' },
    { href: '#rondas', icon: '◎', label: 'Rondas' },
    { href: '#informes-evolucion', icon: '∿', label: 'Evolución' },
    { href: '#informes', icon: '▤', label: 'Informes' },
    { href: '#reglas', icon: '⚙', label: 'Reglas' },
    { href: '#usuarios', icon: '♙', label: 'Usuarios' },
    { href: '#recintos', icon: '▦', label: 'Recintos' },
    { href: '#seguridad', icon: '◇', label: 'Seguridad' },
    // Consentimiento del trabajador (#78). Dos entradas y no una: publicar el
    // aviso y demostrar que no se registro ubicacion fuera de turno son dos
    // preguntas distintas, y la segunda es la que hay que contestar cuando
    // alguien reclama.
    { href: '#aviso-geolocalizacion', icon: '⚖', label: 'Consentimiento' },
    { href: '#rastreo-fuera-de-turno', icon: '⌖', label: 'Fuera de turno' },
    { href: '#sesiones', icon: '◉', label: 'Sesiones' },
  ],
  SUPERVISOR: [
    { href: '#resumen', icon: '⌂', label: 'Resumen' },
    { href: '#editor-rutas', icon: '⌁', label: 'Editor de rutas' },
    { href: '#rondas', icon: '◎', label: 'Rondas asignadas' },
    { href: '#turnos', icon: '▦', label: 'Programar turnos' },
    { href: '#monitoreo', icon: '●', label: 'Monitoreo en vivo' },
    { href: '#informes-evolucion', icon: '∿', label: 'Evolución' },
    { href: '#informes', icon: '▤', label: 'Informes' },
    // El supervisor tambien opera desde la app y tambien se le registra el
    // recorrido: su propio aviso tiene que estar a la vista, no escondido.
    { href: '#consentimiento', icon: '⌖', label: 'Mi ubicación' },
    { href: '#sesiones', icon: '◉', label: 'Sesiones' },
  ],
};

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
            {(ROLE_NAVIGATION[role] ?? []).map((item, index) => (
              <a className={`nav-item${index === 0 ? ' active' : ''}`} href={item.href} key={item.href}>
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </a>
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
