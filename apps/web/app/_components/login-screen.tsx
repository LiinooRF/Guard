'use client';

import type { Role } from '@voxia/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Brand } from './brand';

const DEMO_ROLES: Array<{ role: Role; label: string; description: string; href: string }> = [
  {
    role: 'GUARDIA',
    label: 'Guardia',
    description: 'Turno, ronda activa y escaneo de puntos',
    href: '/demo/guardia',
  },
  {
    role: 'SUPERVISOR',
    label: 'Supervisor',
    description: 'Monitoreo operativo de recintos y alertas',
    href: '/demo/supervisor',
  },
  {
    role: 'ADMIN',
    label: 'Administrador',
    description: 'Personas, recintos, reglas e informes',
    href: '/demo/admin',
  },
  {
    role: 'SUPERADMIN',
    label: 'Superadmin',
    description: 'Empresas, planes y salud de la plataforma',
    href: '/demo/superadmin',
  },
];

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
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:13001/api'}/auth/login`,
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

      router.push(`/demo/${result.user.role.toLowerCase()}`);
      router.refresh();
    } catch {
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  function useDemoAccount() {
    setIdentity('guardia@demo-andina.test');
    setPassword('DemoGuardia2026!');
    setStatus('idle');
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
            <div className="form-options">
              <label className="checkbox-label">
                <input type="checkbox" /> Mantener sesión
              </label>
              <button className="text-button" type="button">¿Olvidaste tu contraseña?</button>
            </div>
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
            <button className="demo-login-button" onClick={useDemoAccount} type="button">
              Completar cuenta demo de Guardia
            </button>
            <p className="form-note">Cuenta local de prueba; no existe en producción.</p>
          </form>

          <div className="demo-area">
            <div className="demo-heading">
              <span>Vista previa por rol</span>
              <small>Datos demostrativos</small>
            </div>
            <div className="role-grid">
              {DEMO_ROLES.map((item) => (
                <Link className="role-link" href={item.href} key={item.role}>
                  <span className={`role-icon role-${item.role.toLowerCase()}`}>
                    {item.label.charAt(0)}
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  <b aria-hidden="true">›</b>
                </Link>
              ))}
            </div>
          </div>
        </div>
        <footer>VoxIA Control · Entorno de desarrollo · v0.2</footer>
      </section>
    </main>
  );
}
