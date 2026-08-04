'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useGuardBridge } from './use-guard-bridge';

export interface GuardHomeData {
  hasAssignment: boolean;
  message?: string;
  shift?: {
    scheduledStartAt: string;
    scheduledEndAt: string;
  };
  patrol?: {
    id: string;
    status: 'pendiente' | 'en_curso';
    siteName: string;
    routeName: string;
    estimatedDurationMin: number;
    completedCheckpointCount: number;
    checkpoints: Array<{
      id: string;
      name: string;
      position: number;
      isClosingPoint?: boolean;
      tagUids: string[];
    }>;
  };
  synchronization: { pendingItems: number };
}

const time = new Intl.DateTimeFormat('es-CL', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Santiago',
});

export function GuardHome({ data, apiUrl }: { data: GuardHomeData; apiUrl: string }) {
  const router = useRouter();
  const puente = useGuardBridge(apiUrl);
  const guardarRutaOffline = puente.guardarRutaOffline;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!data.hasAssignment || !data.patrol || !data.shift) return;
    void guardarRutaOffline({
      patrolId: data.patrol.id,
      status: data.patrol.status,
      siteName: data.patrol.siteName,
      routeName: data.patrol.routeName,
      scheduledStartAt: data.shift.scheduledStartAt,
      scheduledEndAt: data.shift.scheduledEndAt,
      estimatedDurationMin: data.patrol.estimatedDurationMin,
      checkpoints: data.patrol.checkpoints,
    }).catch(() => undefined);
  }, [data, guardarRutaOffline]);

  if (!data.hasAssignment || !data.patrol || !data.shift) {
    return (
      <section className="empty-assignment" aria-live="polite">
        <span className="empty-icon">✓</span>
        <h2>No tienes un turno asignado</h2>
        <p>{data.message ?? 'Cuando te asignen una ronda, aparecerá aquí automáticamente.'}</p>
        <ConnectionStatus pendingItems={data.synchronization.pendingItems} />
      </section>
    );
  }

  const { patrol, shift } = data;
  const total = patrol.checkpoints.length;
  const completed = patrol.completedCheckpointCount;
  const pending = patrol.status === 'pendiente';

  async function startPatrol() {
    setStarting(true);
    setError(undefined);
    try {
      const response = await fetch(`${apiUrl}/guard/patrols/${patrol.id}/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Voxia-Request': 'web' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? 'No pudimos iniciar la ronda');
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos iniciar la ronda');
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <section className="guard-focus-card" id="operacion">
        <div className="guard-status-row">
          <span className={`status-pill ${pending ? 'pending' : 'active'}`}>
            {pending ? 'Lista para iniciar' : 'Ronda en curso'}
          </span>
          <ConnectionStatus pendingItems={data.synchronization.pendingItems} compact />
        </div>
        <span className="eyebrow">Tu tarea ahora</span>
        <h2>{patrol.routeName}</h2>
        <p className="guard-site">{patrol.siteName}</p>

        {pending ? (
          <button className="guard-primary-action" type="button" onClick={startPatrol} disabled={starting}>
            {starting ? 'Iniciando…' : 'Iniciar ronda'}
          </button>
        ) : (
          <button className="guard-primary-action" type="button">
            Escanear punto NFC
          </button>
        )}
        {error ? <p className="guard-action-error" role="alert">{error}</p> : null}

        <div className="guard-shift-grid">
          <span><small>Turno</small><strong>{time.format(new Date(shift.scheduledStartAt))} — {time.format(new Date(shift.scheduledEndAt))}</strong></span>
          <span><small>Progreso</small><strong>{completed} de {total} puntos</strong></span>
          <span><small>Duración estimada</small><strong>{patrol.estimatedDurationMin} min</strong></span>
        </div>

        <ol className="guard-checkpoints" aria-label="Puntos de la ronda">
          {patrol.checkpoints.map((checkpoint) => (
            <li key={checkpoint.id}>
              <span>{checkpoint.position}</span>
              <strong>{checkpoint.name}</strong>
            </li>
          ))}
        </ol>

      </section>
    </>
  );
}

function ConnectionStatus({
  pendingItems,
  compact = false,
}: {
  pendingItems: number;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'connection-status compact' : 'connection-status'}>
      <span><i /> En línea</span>
      <span>{pendingItems === 0 ? 'Todo sincronizado' : `${pendingItems} pendientes`}</span>
    </div>
  );
}
