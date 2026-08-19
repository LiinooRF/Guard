'use client';

import type { Role } from '@sentrycore/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Brand } from './brand';
import { esAppDelGuardia } from '../_lib/app-del-guardia';
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
  const [nfcFeedback, setNfcFeedback] = useState<string | null>(null);
  const [pendingCardUid, setPendingCardUid] = useState<string | null>(null);
  const [nfcPin, setNfcPin] = useState('');

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

  const loginWithNfc = useCallback(
    async (cardUid: string, pin?: string) => {
      if (!cardUid || status === 'loading') return;
      if (!navigator.onLine) {
        setStatus('offline');
        return;
      }
      setStatus('loading');
      setErrorMessage('');
      setNfcFeedback(`Tarjeta NFC detectada (${cardUid}) · Iniciando sesión…`);

      try {
        const response = await fetch(`${apiUrl}/auth/nfc-login`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardUid,
            ...(pin ? { pin } : {}),
            ...(tenantId ? { tenantId } : {}),
          }),
        });

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
          setNfcFeedback(null);
          return;
        }
        if (!response.ok || !result.user) {
          // Que falte el PIN no es un error del guardia: es el estado en que
          // el portal tiene que pedirlo (ver auth.service.ts). Se guarda el
          // UID ya leído para no obligar a un segundo toque de tarjeta.
          if (result.code === 'NFC_PIN_REQUIRED') {
            setPendingCardUid(cardUid);
            setNfcPin('');
            setStatus('idle');
            setNfcFeedback(null);
            return;
          }
          setPendingCardUid(null);
          setErrorMessage(
            result.code === 'TENANT_SUSPENDED' && typeof result.message === 'string'
              ? result.message
              : 'No se reconoció la tarjeta NFC o el guardia no está activo.',
          );
          setStatus('error');
          setNfcFeedback(null);
          return;
        }

        setPendingCardUid(null);
        router.push(`/app/${result.user.role.toLowerCase()}`);
        router.refresh();
      } catch {
        setStatus(navigator.onLine ? 'error' : 'offline');
        setNfcFeedback(null);
      }
    },
    [apiUrl, router, status, tenantId],
  );

  useEffect(() => {
    function alDetectarTarjetaNfc(uid: string) {
      if (mode !== 'login') return;
      // Mientras se espera el PIN de un toque anterior, un reintento de
      // lectura de la MISMA tarjeta (el lector queda armado unos segundos
      // más) no debe reiniciar el flujo ni gastar otro intento fallido.
      if (pendingCardUid) return;
      void loginWithNfc(uid);
    }

    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ uid: string }>;
      if (custom.detail?.uid) alDetectarTarjetaNfc(custom.detail.uid);
    };

    (window as unknown as { __sentrycoreNfcLogin?: (uid: string) => void }).__sentrycoreNfcLogin =
      alDetectarTarjetaNfc;
    window.addEventListener('sentrycore:nfc:login', handler);

    return () => {
      delete (window as unknown as { __sentrycoreNfcLogin?: unknown }).__sentrycoreNfcLogin;
      window.removeEventListener('sentrycore:nfc:login', handler);
    };
  }, [mode, loginWithNfc, pendingCardUid]);

  async function submitNfcPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingCardUid) return;
    if (!nfcPin.trim()) {
      setErrorMessage('Ingresa el PIN de la tarjeta.');
      setStatus('error');
      return;
    }
    await loginWithNfc(pendingCardUid, nfcPin.trim());
  }

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

      /*
       * Dentro de la app hay dos señales mejores que el user-agent:
       * `ReactNativeWebView`, que solo existe en un WebView de React Native, y
       * el puente ya inyectado. El user-agent queda de respaldo porque puede
       * llegar recortado, y porque un APK viejo puede tardar en inyectar el
       * puente: expulsar al guardia por llegar un instante antes seria repetir
       * el bug del renombre por otra via.
       */
      const dentroDeLaApp =
        typeof window !== 'undefined' &&
        (Boolean((window as unknown as { __sentrycorePuente?: unknown }).__sentrycorePuente) ||
          Boolean((window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView) ||
          esAppDelGuardia(navigator.userAgent));

      if (result.user.role === 'GUARDIA' && !dentroDeLaApp) {
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
              ? 'Ingresa tus credenciales o acerca tu tarjeta NFC.'
              : mode === 'recovery'
                ? 'Te enviaremos un enlace si el correo está registrado.'
                : 'Define una contraseña segura para continuar.'}
          </p>

          {nfcFeedback ? (
            <div
              className="form-message info"
              role="status"
              style={{
                marginBottom: '1rem',
                backgroundColor: '#eff6ff',
                color: '#1d4ed8',
                border: '1px solid #bfdbfe',
                borderRadius: '0.5rem',
                padding: '0.75rem',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              <span>📇 {nfcFeedback}</span>
            </div>
          ) : null}

          {mode === 'login' && pendingCardUid ? (
            <form className="login-form" noValidate onSubmit={submitNfcPin}>
              <label>
                PIN de la tarjeta
                <input
                  autoComplete="off"
                  autoFocus
                  inputMode="numeric"
                  onChange={(event) => {
                    setNfcPin(event.target.value);
                    setStatus('idle');
                    setErrorMessage('');
                  }}
                  placeholder="••••"
                  required
                  type="password"
                  value={nfcPin}
                />
              </label>
              {status === 'error' ? (
                <p className="form-message error" role="alert">
                  {errorMessage || 'PIN incorrecto. Inténtalo nuevamente.'}
                </p>
              ) : null}
              {status === 'offline' ? (
                <p className="form-message offline" role="alert">
                  Estás sin conexión. Comprueba tu red para continuar.
                </p>
              ) : null}
              <button className="primary-button" disabled={status === 'loading'} type="submit">
                {status === 'loading' ? 'Verificando…' : 'Confirmar PIN'}
              </button>
              <button
                className="text-button recovery-link"
                onClick={() => {
                  setPendingCardUid(null);
                  setNfcPin('');
                  setStatus('idle');
                  setErrorMessage('');
                }}
                type="button"
              >
                Cancelar y usar otra tarjeta
              </button>
            </form>
          ) : null}

          {mode === 'login' && !pendingCardUid ? <form className="login-form" noValidate onSubmit={submit}>
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
        <footer>SentryCore · Acceso seguro</footer>
      </section>
    </main>
  );
}
