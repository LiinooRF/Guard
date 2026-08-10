import type { GuardHomeData } from './guard-home';

export function GuardPoints({ data }: { data: GuardHomeData }) {
  const patrol = data.patrol;
  if (!data.hasAssignment || !patrol) {
    return (
      <section className="empty-assignment" aria-live="polite">
        <span className="empty-icon">✓</span>
        <h2>No hay puntos asignados</h2>
        <p>Los puntos aparecerán aquí cuando tengas una ronda asignada.</p>
      </section>
    );
  }

  return (
    <section className="guard-points-page">
      <header>
        <span className="eyebrow">Recorrido asignado</span>
        <h2>{patrol.routeName}</h2>
        <p>{patrol.siteName} · {patrol.checkpoints.length} puntos</p>
      </header>
      <ol className="guard-checkpoints" aria-label="Puntos de la ronda">
        {patrol.checkpoints.map((checkpoint) => (
          <li key={checkpoint.id}>
            <span>{checkpoint.position}</span>
            <strong>{checkpoint.name}</strong>
            {checkpoint.kind === 'acceso_critico' ? <small>Acceso crítico</small> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
