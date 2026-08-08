import type { ReactNode } from 'react';

import { Brand } from './brand';
import { SesionViva } from './sesion-viva';
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
    // Vista de envios de correo para soporte (#221). Va pegada a Informes: la
    // pregunta que trae al ADMIN aca es «¿le llegó el informe al cliente?», y se
    // la hace justo despues de mirar el informe.
    { href: '#envios', icon: '✉', label: 'Envíos de correo' },
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
    // La revision por recinto del supervisor (#99) se dibuja despues de
    // StatsCharts y sin esta entrada solo se llega scrolleando. El panel
    // existia armado y sin montar; montarlo sin como llegar es el mismo
    // problema una casilla mas adelante.
    { href: '#supervisor', icon: '⌸', label: 'Revision de rondas' },
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
      {/* Renueva el token antes de que venza. Va en el shell y no en cada panel
          porque el problema es de TODOS los roles: quien deja la pantalla
          abierta sin enviar nada se queda sin sesion a los 15 minutos. */}
      <SesionViva />
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
