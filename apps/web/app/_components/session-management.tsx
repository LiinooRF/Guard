'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface UserSession {
  id: string;
  device: string;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export function SessionManagement({
  sessions,
  apiUrl,
}: {
  sessions: UserSession[];
  apiUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  async function revoke(session: UserSession) {
    const response = await fetch(`${apiUrl}/auth/sessions/${session.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      setMessage('No fue posible cerrar la sesión.');
      return;
    }
    if (session.current) {
      router.replace('/');
      router.refresh();
      return;
    }
    setMessage('Sesión cerrada correctamente.');
    startTransition(() => router.refresh());
  }

  async function revokeAll() {
    const response = await fetch(`${apiUrl}/auth/sessions`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      setMessage('No fue posible cerrar las sesiones.');
      return;
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <section className="management-card management-wide" id="sesiones">
      <div className="card-heading">
        <div><span className="eyebrow">Seguridad</span><h2>Sesiones activas</h2></div>
        <button className="secondary-button danger-button" disabled={pending || !sessions.length} onClick={revokeAll}>
          Cerrar todas
        </button>
      </div>
      <p className="section-explanation">Revisa los dispositivos con acceso y cierra cualquiera que no reconozcas.</p>
      {message ? <p className="management-message" role="status">{message}</p> : null}
      <div className="management-list">
        {sessions.map((session) => (
          <article className="management-row" key={session.id}>
            <div>
              <strong>{friendlyDevice(session.device)}</strong>
              <small>Último uso: {formatDateTime(session.lastUsedAt)}</small>
              <small>Iniciada: {formatDateTime(session.createdAt)}</small>
            </div>
            <span className={`state-chip ${session.current ? 'active' : ''}`}>
              {session.current ? 'Esta sesión' : 'Activa'}
            </span>
            <button className="secondary-button" disabled={pending} onClick={() => revoke(session)}>
              Cerrar
            </button>
          </article>
        ))}
        {!sessions.length ? (
          <div className="dashboard-empty"><strong>Sin sesiones registradas</strong><span>Vuelve a iniciar sesión para registrar este dispositivo.</span></div>
        ) : null}
      </div>
    </section>
  );
}

function friendlyDevice(userAgent: string) {
  if (/android/i.test(userAgent)) return 'Android';
  if (/iphone|ipad/i.test(userAgent)) return 'iPhone o iPad';
  if (/firefox/i.test(userAgent)) return 'Firefox';
  if (/edg/i.test(userAgent)) return 'Microsoft Edge';
  if (/chrome/i.test(userAgent)) return 'Google Chrome';
  if (/safari/i.test(userAgent)) return 'Safari';
  return userAgent || 'Dispositivo desconocido';
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
