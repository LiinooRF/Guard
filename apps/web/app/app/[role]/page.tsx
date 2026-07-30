import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { DashboardShell } from '../../_components/dashboard-shell';
import { GuardHome, type GuardHomeData } from '../../_components/guard-home';

const ROLE_CONTENT = {
  guardia: {
    role: 'GUARDIA',
    title: 'Buenas noches, Matías',
    subtitle: 'Tu turno está activo en Planta Lo Boza.',
    stats: [
      ['Turno', '22:00 — 06:00', 'En curso'],
      ['Ronda actual', '2 de 6 puntos', '33% completada'],
      ['Sincronización', 'Todo al día', 'Último envío hace 1 min'],
    ],
  },
  supervisor: {
    role: 'SUPERVISOR',
    title: 'Operación de esta noche',
    subtitle: 'Visibilidad en tiempo real de tus recintos asignados.',
    stats: [
      ['Rondas activas', '8', '6 sin novedades'],
      ['Cumplimiento', '92%', '+4% esta semana'],
      ['Alertas abiertas', '2', 'Requieren revisión'],
    ],
  },
  admin: {
    role: 'ADMIN',
    title: 'Resumen de Seguridad Andina',
    subtitle: 'Indicadores consolidados de todos tus recintos.',
    stats: [
      ['Recintos', '12', 'Todos operativos'],
      ['Cumplimiento mensual', '94,8%', '+2,1% vs. junio'],
      ['Guardias activos', '46', '11 en turno ahora'],
    ],
  },
  superadmin: {
    role: 'SUPERADMIN',
    title: 'Estado de la plataforma',
    subtitle: 'Empresas, operación y capacidad global.',
    stats: [
      ['Empresas activas', '24', '+3 este mes'],
      ['Rondas hoy', '1.284', '99,7% procesadas'],
      ['Salud del sistema', 'Operativa', 'Sin incidentes'],
    ],
  },
} as const;

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

  return (
    <DashboardShell role={content.role} title={content.title} subtitle={content.subtitle}>
      <section className="stat-grid" id="resumen">
        {content.stats.map(([label, value, detail]) => (
          <article className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </section>

      <section className="dashboard-grid" id="operacion">
        <article className="operation-card">
          <div className="card-heading">
            <div><span className="eyebrow">Ronda prioritaria</span><h2>Perímetro nocturno</h2></div>
            <span className="status-pill">En curso</span>
          </div>
          <div className="route-progress">
            <span className="checkpoint done">✓<small>Acceso</small></span>
            <i />
            <span className="checkpoint done">✓<small>Bodega</small></span>
            <i />
            <span className="checkpoint current">3<small>Patio norte</small></span>
            <i />
            <span className="checkpoint">4<small>Generador</small></span>
            <i />
            <span className="checkpoint">5<small>Portón</small></span>
          </div>
          <div className="operation-meta">
            <span><small>Inicio</small><strong>23:06</strong></span>
            <span><small>Guardia</small><strong>Matías Castro</strong></span>
            <span><small>Tiempo estimado</small><strong>28 min</strong></span>
          </div>
        </article>

        <article className="alerts-card" id="alertas">
          <div className="card-heading"><div><span className="eyebrow">Atención</span><h2>Alertas recientes</h2></div><b>2</b></div>
          <ul className="alert-list">
            <li><span className="alert-dot critical" /><span><strong>Ronda con atraso</strong><small>Planta Quilicura · hace 8 min</small></span></li>
            <li><span className="alert-dot warning" /><span><strong>GPS con baja precisión</strong><small>Estacionamiento -2 · hace 14 min</small></span></li>
            <li><span className="alert-dot ok" /><span><strong>Ronda completada</strong><small>Centro logístico · 100%</small></span></li>
          </ul>
        </article>
      </section>

      <section className="activity-card" id="informes">
        <div className="card-heading"><div><span className="eyebrow">Actividad</span><h2>Últimos eventos</h2></div><button className="text-button">Ver informe completo →</button></div>
        <div className="activity-row"><time>23:24</time><span className="event-icon success">✓</span><span><strong>Punto “Bodega 2” validado</strong><small>NFC · GPS dentro del radio · evidencia recibida</small></span><b>Correcto</b></div>
        <div className="activity-row"><time>23:17</time><span className="event-icon success">✓</span><span><strong>Punto “Acceso principal” validado</strong><small>NFC · fotografía obligatoria adjunta</small></span><b>Correcto</b></div>
        <div className="activity-row"><time>23:06</time><span className="event-icon neutral">→</span><span><strong>Ronda iniciada</strong><small>Dispositivo Android autorizado</small></span><b>En curso</b></div>
      </section>
    </DashboardShell>
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

function noAssignment(): GuardHomeData {
  return {
    hasAssignment: false,
    message: 'Inicia sesión como guardia para consultar una asignación real.',
    synchronization: { pendingItems: 0 },
  };
}
