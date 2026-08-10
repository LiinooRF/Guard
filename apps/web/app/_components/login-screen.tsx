'use client';

import type { Role } from '@voxia/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { Brand } from './brand';
import { leerCredenciales } from './login-form-data';

export function LoginScreen() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';
  const [showPassword, setShowPassword] = useState(false);
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [mode, setMode] = useState<'login' | 'recovery' | 'action'>('login');
  const [action, setAction] = useState<{ purpose: 'invite' | 'reset'; token: string } | null>(
    null,
  );
  const [status, setStatus] = useState<
    'idle' | 'loading' | 'error' | 'offline' | 'success'
  >('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [tenantChoices, setTenantChoices] = useState<
    Array<{ tenantId: string; tenantName: string; role: Role }>
  >([]);

  useEffect(() => {
    function readActionLink() {
      const parameters = new URLSearchParams(window.location.hash.slice(1));
      const invitation = parameters.get('invite');
      const reset = parameters.get('reset');
      if (invitation) {
        setAction({ purpose: 'invite', token: invitation });
        setMode('action');
      } else if (reset) {
        setAction({ purpose: 'reset', token: reset });
        setMode('action');
      }
    }
    readActionLink();
    window.addEventListener('hashchange', readActionLink);
    return () => window.removeEventListener('hashchange', readActionLink);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credenciales = leerCredenciales(new FormData(event.currentTarget));
    if (!credenciales.identity || !credenciales.password) {
      setErrorMessage('Completa el usuario y la contraseña para continuar.');
      setStatus('error');
      return;
    }
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }

    setStatus('loading');
    setErrorMessage('');

    try {
      const response = await fetch(
        `${apiUrl}/auth/login`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identity: credenciales.identity,
            password: credenciales.password,
            ...(credenciales.tenantId ? { tenantId: credenciales.tenantId } : {}),
          }),
        },
      );
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        setErrorMessage(
          'El servicio de acceso no está disponible en este momento. Inténtalo nuevamente.',
        );
        setStatus('error');
        return;
      }

      const result = (await response.json()) as {
        requiresTenantSelection?: boolean;
        tenants?: Array<{ tenantId: string; tenantName: string; role: Role }>;
        user?: { role: Role };
        code?: string;
        message?: string | string[];
      };

      if (result.requiresTenantSelection && result.tenants) {
        setTenantChoices(result.tenants);
        setStatus('idle');
        return;
      }
      if (!response.ok || !result.user) {
        setErrorMessage(
          result.code === 'TENANT_SUSPENDED' && typeof result.message === 'string'
            ? result.message
            : 'No pudimos iniciar sesión. Revisa tus credenciales e inténtalo nuevamente.',
        );
        setStatus('error');
        return;
      }

      if (
        result.user.role === 'GUARDIA' &&
        !navigator.userAgent.includes('VoxIAAndroid/')
      ) {
        await fetch(`${apiUrl}/auth/logout`, {
          method: 'POST',
          credentials: 'include',
        });
        setErrorMessage('El acceso de guardia está disponible únicamente en la app Android.');
        setStatus('error');
        return;
      }

      router.push(`/app/${result.user.role.toLowerCase()}`);
      router.refresh();
    } catch {
      setErrorMessage(
        'No pudimos conectar con el servicio de acceso. Comprueba tu conexión e inténtalo nuevamente.',
      );
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  async function requestRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.trim())) {
      setErrorMessage('Ingresa un correo válido.');
      return setStatus('error');
    }
    if (!navigator.onLine) return setStatus('offline');
    setStatus('loading');
    try {
      await fetch(`${apiUrl}/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoveryEmail }),
      });
      setStatus('success');
    } catch {
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  async function completeAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || password.length < 12 || password !== confirmation) {
      setErrorMessage('La contraseña debe tener 12 caracteres y ambas entradas deben coincidir.');
      return setStatus('error');
    }
    if (!navigator.onLine) return setStatus('offline');
    setStatus('loading');
    try {
      const endpoint =
        action.purpose === 'invite' ? 'invitations/complete' : 'password-reset/complete';
      const response = await fetch(`${apiUrl}/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: action.token, password }),
      });
      if (!response.ok) {
        setErrorMessage('Este enlace no es válido o ya venció. Solicita uno nuevo.');
        return setStatus('error');
      }
      window.history.replaceState(null, '', window.location.pathname);
      setAction(null);
      setPassword('');
      setConfirmation('');
      setMode('login');
      setStatus('success');
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
          <span className="eyebrow">
            {mode === 'login' ? 'Portal de operaciones' : 'Acceso seguro'}
          </span>
          <h2>
            {mode === 'login'
              ? 'Bienvenido de vuelta'
              : mode === 'recovery'
                ? 'Recupera tu acceso'
                : action?.purpose === 'invite'
                  ? 'Activa tu cuenta'
                  : 'Nueva contraseña'}
          </h2>
          <p className="login-intro">
            {mode === 'login'
              ? 'Ingresa con las credenciales entregadas por tu organización.'
              : mode === 'recovery'
                ? 'Te enviaremos un enlace si el correo está registrado.'
                : 'Define una contraseña segura para continuar.'}
          </p>

          {mode === 'login' ? <form className="login-form" noValidate onSubmit={submit}>
            <label>
              Usuario o correo
              <input
                autoComplete="username"
                name="identity"
                onChange={(event) => {
                  setIdentity(event.target.value);
                  setStatus('idle');
                  setErrorMessage('');
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
                    setErrorMessage('');
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
                  name="tenantId"
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
                {errorMessage || 'Completa todos los campos para continuar.'}
              </p>
            ) : null}
            {status === 'offline' ? (
              <p className="form-message offline" role="alert">
                Estás sin conexión. Comprueba tu red para iniciar sesión.
              </p>
            ) : null}
            {status === 'success' ? (
              <p className="form-message success" role="status">
                Contraseña definida correctamente. Ya puedes iniciar sesión.
              </p>
            ) : null}
            <button className="primary-button" disabled={status === 'loading'} type="submit">
              {status === 'loading' ? 'Verificando…' : 'Ingresar'}
              <span aria-hidden="true">{status === 'loading' ? '···' : '→'}</span>
            </button>
            <button
              className="text-button recovery-link"
              onClick={() => {
                setMode('recovery');
                setStatus('idle');
              }}
              type="button"
            >
              ¿Olvidaste tu contraseña?
            </button>
          </form> : null}

          {mode === 'recovery' ? (
            <form className="login-form" noValidate onSubmit={requestRecovery}>
              <label>
                Correo
                <input
                  autoComplete="email"
                  inputMode="email"
                  onChange={(event) => {
                    setRecoveryEmail(event.target.value);
                    setStatus('idle');
                  }}
                  required
                  type="email"
                  value={recoveryEmail}
                />
              </label>
              {status === 'success' ? (
                <p className="form-message success" role="status">
                  Si el correo está registrado, recibirás instrucciones en unos minutos.
                </p>
              ) : null}
              {status === 'offline' ? (
                <p className="form-message offline" role="alert">
                  Estás sin conexión. Comprueba tu red para continuar.
                </p>
              ) : null}
              {status === 'error' ? (
                <p className="form-message error" role="alert">
                  {errorMessage || 'No pudimos procesar la solicitud. Inténtalo nuevamente.'}
                </p>
              ) : null}
              <button className="primary-button" disabled={status === 'loading'} type="submit">
                {status === 'loading' ? 'Enviando…' : 'Enviar instrucciones'}
              </button>
              <button
                className="text-button recovery-link"
                onClick={() => {
                  setMode('login');
                  setStatus('idle');
                }}
                type="button"
              >
                Volver al inicio de sesión
              </button>
            </form>
          ) : null}

          {mode === 'action' ? (
            <form className="login-form" noValidate onSubmit={completeAction}>
              <label>
                Nueva contraseña
                <input
                  autoComplete="new-password"
                  minLength={12}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setStatus('idle');
                  }}
                  required
                  type="password"
                  value={password}
                />
              </label>
              <label>
                Repite la contraseña
                <input
                  autoComplete="new-password"
                  minLength={12}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                    setStatus('idle');
                  }}
                  required
                  type="password"
                  value={confirmation}
                />
              </label>
              {status === 'error' ? (
                <p className="form-message error" role="alert">{errorMessage}</p>
              ) : null}
              {status === 'offline' ? (
                <p className="form-message offline" role="alert">
                  Estás sin conexión. Comprueba tu red para continuar.
                </p>
              ) : null}
              <button className="primary-button" disabled={status === 'loading'} type="submit">
                {status === 'loading' ? 'Guardando…' : 'Definir contraseña'}
              </button>
            </form>
          ) : null}
        </div>
        <footer>VoxIA Control · Acceso seguro</footer>
      </section>
    </main>
  );
}
