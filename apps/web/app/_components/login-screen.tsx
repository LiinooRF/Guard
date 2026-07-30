'use client';

import type { Role } from '@voxia/shared';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Brand } from './brand';

export function LoginScreen() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'offline'>('idle');
  const [tenantId, setTenantId] = useState('');
  const [tenantChoices, setTenantChoices] = useState<
    Array<{ tenantId: string; tenantName: string; role: Role }>
  >([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity.trim() || !password) {
      setStatus('error');
      return;
    }
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }

    setStatus('loading');

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? '/api'}/auth/login`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identity,
            password,
            ...(tenantId ? { tenantId } : {}),
          }),
        },
      );
      const result = (await response.json()) as {
        requiresTenantSelection?: boolean;
        tenants?: Array<{ tenantId: string; tenantName: string; role: Role }>;
        user?: { role: Role };
      };

      if (result.requiresTenantSelection && result.tenants) {
        setTenantChoices(result.tenants);
        setStatus('idle');
        return;
      }
      if (!response.ok || !result.user) {
        setStatus('error');
        return;
      }

      router.push(`/app/${result.user.role.toLowerCase()}`);
      router.refresh();
    } catch {
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story">
        <Brand />
        <div className="story-copy">
          <span className="eyebrow">Seguridad operacional verificable</span>
          <h1>Cada ronda.<br />Cada punto.<br /><em>Bajo control.</em></h1>
          <p>
            Supervisa recorridos en tiempo real, valida presencia con NFC y conserva evidencia
            confiable incluso cuando el guardia trabaja sin conexión.
          </p>
        </div>
        <div className="trust-row" aria-label="Características principales">
          <span>● Operación en línea</span>
          <span>NFC + GPS</span>
          <span>Modo offline</span>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="mobile-brand"><Brand /></div>
          <span className="eyebrow">Portal de operaciones</span>
          <h2>Bienvenido de vuelta</h2>
          <p className="login-intro">Ingresa con las credenciales entregadas por tu organización.</p>

          <form className="login-form" noValidate onSubmit={submit}>
            <label>
              Usuario o correo
              <input
                autoComplete="username"
                name="identity"
                onChange={(event) => {
                  setIdentity(event.target.value);
                  setStatus('idle');
                }}
                placeholder="tu.usuario"
                required
                value={identity}
              />
            </label>
            <label>
              Contraseña
              <span className="password-field">
                <input
                  autoComplete="current-password"
                  name="password"
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setStatus('idle');
                  }}
                  placeholder="••••••••"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="reveal-button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  type="button"
                >
                  {showPassword ? 'Ocultar' : 'Ver'}
                </button>
              </span>
            </label>
            {tenantChoices.length > 1 ? (
              <label>
                Empresa
                <select
                  onChange={(event) => setTenantId(event.target.value)}
                  required
                  value={tenantId}
                >
                  <option value="">Selecciona dónde ingresar</option>
                  {tenantChoices.map((tenant) => (
                    <option key={tenant.tenantId} value={tenant.tenantId}>
                      {tenant.tenantName} · {tenant.role}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {status === 'error' ? (
              <p className="form-message error" role="alert">
                No pudimos iniciar sesión. Revisa tus credenciales e inténtalo nuevamente.
              </p>
            ) : null}
            {status === 'offline' ? (
              <p className="form-message offline" role="alert">
                Estás sin conexión. Comprueba tu red para iniciar sesión.
              </p>
            ) : null}
            <button className="primary-button" disabled={status === 'loading'} type="submit">
              {status === 'loading' ? 'Verificando…' : 'Ingresar'}
              <span aria-hidden="true">{status === 'loading' ? '···' : '→'}</span>
            </button>
          </form>
        </div>
        <footer>VoxIA Control · Acceso seguro</footer>
      </section>
    </main>
  );
}
