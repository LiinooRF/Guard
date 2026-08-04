'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LiveGuardMap, type LivePosition } from './live-guard-map';

interface LivePatrol {
  id: string; siteName: string; routeName: string; guardName: string;
  status: 'pendiente' | 'en_curso'; scheduledStartAt: string; scheduledEndAt: string;
  startedAt: string | null; expectedCheckpoints: number; scannedCheckpoints: number;
  progressPct: number; lastCheckpointName: string | null; lastScanAt: string | null;
  gpsEnabled: boolean;
  position: null | { latitude: number; longitude: number; recordedAt: string; accuracyM: number | null };
}
interface LiveResponse { refreshedAt: string; pollAfterMs: number; patrols: LivePatrol[] }

export function LivePatrolBoard({
  apiUrl,
  tileUrl,
  attribution,
}: {
  apiUrl: string;
  tileUrl: string | null;
  attribution: string;
}) {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`${apiUrl}/supervisor/live`, {
        credentials: 'include', cache: 'no-store', signal,
      });
      if (!response.ok) throw new Error(`No pudimos actualizar el tablero (${response.status}).`);
      setData(await response.json() as LiveResponse); setError('');
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'No pudimos actualizar el tablero.');
    } finally { inFlight.current = false; }
  }, [apiUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(controller.signal);
    }, 5_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  const positions = useMemo<LivePosition[]>(() => (data?.patrols ?? []).flatMap((patrol) =>
    patrol.position ? [{ patrolId: patrol.id, guardName: patrol.guardName, siteName: patrol.siteName, ...patrol.position }] : [],
  ), [data]);

  return <section className="management-card management-wide live-board" id="monitoreo">
    <div className="card-heading"><div><span className="eyebrow">Actualización cada 5 segundos</span><h2>Rondas en vivo</h2></div><span className="status-pill">{data?.patrols.filter((p) => p.status === 'en_curso').length ?? 0} en curso</span></div>
    {error && <p className="live-error" role="alert">{error}</p>}
    {tileUrl && positions.length > 0 ? <LiveGuardMap positions={positions} tileUrl={tileUrl} attribution={attribution} /> : (
      <p className="live-map-empty">{tileUrl ? 'Aún no hay posiciones GPS para mostrar.' : 'El proveedor de mapas no está configurado. Las rondas siguen actualizándose.'}</p>
    )}
    <div className="live-grid">
      {(data?.patrols ?? []).map((patrol) => <article className="live-patrol" key={patrol.id}>
        <header><div><strong>{patrol.routeName}</strong><span>{patrol.siteName}</span></div><b className={patrol.status}>{patrol.status === 'en_curso' ? 'En curso' : 'Pendiente'}</b></header>
        <p>{patrol.guardName}</p>
        <div className="live-progress" aria-label={`${patrol.progressPct}% completado`}><span style={{ width: `${patrol.progressPct}%` }} /></div>
        <div className="live-progress-label"><strong>{patrol.scannedCheckpoints}/{patrol.expectedCheckpoints} puntos</strong><span>{patrol.progressPct}%</span></div>
        <small>{patrol.lastCheckpointName ? `Último: ${patrol.lastCheckpointName} · ${clock(patrol.lastScanAt)}` : patrol.status === 'pendiente' ? `Comienza ${clock(patrol.scheduledStartAt)}` : 'Esperando el primer escaneo'}</small>
        {patrol.gpsEnabled && <small>{patrol.position ? `GPS ${clock(patrol.position.recordedAt)}${patrol.position.accuracyM ? ` · ±${Math.round(patrol.position.accuracyM)} m` : ''}` : 'GPS habilitado · sin posición reciente'}</small>}
      </article>)}
    </div>
    {data && !data.patrols.length && <div className="dashboard-empty"><strong>No hay rondas activas</strong><span>Las rondas pendientes o en curso aparecerán aquí automáticamente.</span></div>}
    <p className="live-refreshed" aria-live="polite">{data ? `Última actualización: ${clock(data.refreshedAt)}` : 'Conectando…'}</p>
  </section>;
}

function clock(value: string | null): string {
  if (!value) return 'sin registro';
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
