'use client';

import { useEffect, useMemo, useState } from 'react';

export interface OperationalAlert {
  id: string;
  type: 'no_iniciada' | 'atrasada' | 'incompleta' | 'anomalia' | 'incidente_grave';
  severity: 'advertencia' | 'critica';
  title: string;
  details: string | null;
  siteName: string;
  detectedAt: string;
  attendedAt: string | null;
  attendedByName: string | null;
  attendanceComment: string | null;
}

export function OperationalAlerts({ initialAlerts, apiUrl }: {
  initialAlerts: OperationalAlert[];
  apiUrl: string;
}) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useMemo(() => alerts.filter((alert) => !alert.attendedAt).length, [alerts]);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const response = await fetch(`${apiUrl}/supervisor/alerts`, {
          credentials: 'include', cache: 'no-store',
        });
        if (response.ok && mounted) setAlerts((await response.json()) as OperationalAlert[]);
      } catch {
        // El polling es complementario: conservamos la última vista útil.
      }
    }
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [apiUrl]);

  async function attend(alert: OperationalAlert) {
    const comment = comments[alert.id]?.trim() ?? '';
    if (comment.length < 2) {
      setError('Escribe un comentario breve indicando qué se revisó.');
      return;
    }
    setSaving(alert.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/supervisor/alerts/${alert.id}/attend`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      if (!response.ok) throw new Error('request_failed');
      const result = (await response.json()) as { attendedAt: string };
      setAlerts((current) => current.map((item) => item.id === alert.id
        ? { ...item, attendedAt: result.attendedAt, attendanceComment: comment,
            attendedByName: 'Tú' }
        : item));
      setComments((current) => ({ ...current, [alert.id]: '' }));
    } catch {
      setError('No pudimos marcar la alerta. Puede haber sido atendida por otro supervisor.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="activity-card alerts-panel" id="alertas" aria-labelledby="alerts-title">
      <div className="card-heading">
        <div><span className="eyebrow">Atención operacional</span><h2 id="alerts-title">Alertas de ronda</h2></div>
        <span className={`status-pill${pending ? ' alerts-pending' : ''}`}>{pending} pendientes</span>
      </div>
      <p className="form-note">Se actualiza automáticamente. Cada atención queda asociada a tu usuario y exige un comentario.</p>
      {error ? <p className="stats-estado error" role="alert">{error}</p> : null}
      {alerts.length === 0 ? (
        <div className="dashboard-empty"><strong>Sin alertas operacionales</strong><span>Las anomalías y rondas fuera de plazo aparecerán aquí.</span></div>
      ) : (
        <ol className="alerts-list">
          {alerts.map((alert) => (
            <li className={`alert-card ${alert.severity}${alert.attendedAt ? ' attended' : ''}`} key={alert.id}>
              <div className="alert-card-main">
                <span className="alert-severity">{alert.severity === 'critica' ? 'Crítica' : 'Advertencia'}</span>
                <strong>{alert.title}</strong>
                <span>{alert.siteName}{alert.details ? ` · ${alert.details}` : ''}</span>
                <time dateTime={alert.detectedAt}>{formatDate(alert.detectedAt)}</time>
              </div>
              {alert.attendedAt ? (
                <div className="alert-attended">
                  <strong>Atendida por {alert.attendedByName ?? 'un supervisor'}</strong>
                  <span>{alert.attendanceComment}</span>
                </div>
              ) : (
                <form className="alert-attend" onSubmit={(event) => { event.preventDefault(); void attend(alert); }}>
                  <label htmlFor={`alert-comment-${alert.id}`}>Comentario de atención</label>
                  <textarea id={`alert-comment-${alert.id}`} maxLength={500} minLength={2} required
                    value={comments[alert.id] ?? ''}
                    onChange={(event) => setComments((current) => ({ ...current, [alert.id]: event.target.value }))}
                    placeholder="Ej.: Guardia contactado; inició la ronda." />
                  <button className="stats-boton" disabled={saving === alert.id} type="submit">
                    {saving === alert.id ? 'Guardando…' : 'Marcar atendida'}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('es-CL', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}
