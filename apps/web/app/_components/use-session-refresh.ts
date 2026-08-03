'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Renovación silenciosa de la sesión (#38).
 *
 * `voxia_access` dura 15 minutos y `voxia_refresh` 30 días, ambas HttpOnly: el
 * JavaScript no puede leerlas ni saber cuándo vencen. Lo único que el navegador
 * conoce es el `expiresIn` que devuelven `/auth/login` y `/auth/refresh`, así
 * que se guarda el INSTANTE de renovación —no un token— para que todas las
 * pestañas compartan el mismo reloj.
 *
 * Reglas que sostienen el diseño:
 *
 * 1. Se renueva ANTES de vencer, nunca a partir del 401. Reaccionar al error
 *    significa que el usuario ya vio una pantalla rota.
 * 2. Un solo refresco en vuelo por pestaña (`inFlight`) y uno solo por
 *    navegador (candado en localStorage). `/auth/refresh` ROTA el token: si dos
 *    pestañas mandan la misma cookie a la vez, la segunda llega con un token ya
 *    consumido, el servidor lo lee como reutilización y revoca la familia
 *    completa. La tormenta de refrescos no es ineficiencia: cierra la sesión.
 * 3. Si el servidor responde 401 se reintenta con backoff exponencial y, tras
 *    varios intentos, se manda al login. Si no hay red no se gasta ningún
 *    intento: se espera el evento `online` (el guardia trabaja en subterráneos).
 *
 * Móntalo dentro del cascarón autenticado. En la pantalla de login no hay nada
 * que renovar y el 401 sería el estado normal.
 */

const RENEW_AT_KEY = 'voxia.session.renew_at';
const LOCK_KEY = 'voxia.session.refresh_lock';

/** Renovar al 80% de la vida deja 3 minutos de margen sobre los 15 del access. */
const RENEW_FRACTION = 0.8;
const MIN_LEAD_MS = 30_000;
const LOCK_MS = 15_000;
const LOCK_SETTLE_MS = 60;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_UNAUTHORIZED = 4;
const DEFAULT_LIFETIME_MS = 15 * 60 * 1000;

export type SessionRefreshStatus = 'idle' | 'refreshing' | 'offline' | 'expired';

export interface SessionRefreshState {
  status: SessionRefreshStatus;
  /** Espera a que la sesión esté fresca; comparte el refresco en vuelo. */
  refresh: () => Promise<boolean>;
}

interface UseSessionRefreshOptions {
  apiUrl?: string;
  onExpired?: () => void;
}

let inFlight: Promise<number | null> | null = null;
const tabId = Math.random().toString(36).slice(2);

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Almacenamiento bloqueado (WebView restringido): se sigue por pestaña.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento no hay coordinación entre pestañas, pero sí renovación.
  }
}

function readNumber(key: string): number | null {
  const raw = readStorage(key);
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function renewalPoint(lifetimeMs: number): number {
  const lead = Math.max(lifetimeMs * (1 - RENEW_FRACTION), MIN_LEAD_MS);
  return Date.now() + Math.max(lifetimeMs - lead, lifetimeMs / 2);
}

function jitter(): number {
  return Math.floor(Math.random() * 400);
}

function backoff(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) + jitter();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Lo llama la pantalla de login con el `expiresIn` de la respuesta. */
export function rememberSessionLifetime(expiresInSeconds: number): void {
  const lifetimeMs = expiresInSeconds > 0 ? expiresInSeconds * 1000 : DEFAULT_LIFETIME_MS;
  writeStorage(RENEW_AT_KEY, String(renewalPoint(lifetimeMs)));
}

async function performRefresh(apiUrl: string): Promise<number | null> {
  const response = await fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
  });
  // 401 es "esta sesión ya no existe"; el resto son fallas transitorias.
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`refresh_${response.status}`);

  const body = (await response.json()) as { expiresIn?: number };
  const lifetimeMs =
    typeof body.expiresIn === 'number' && body.expiresIn > 0
      ? body.expiresIn * 1000
      : DEFAULT_LIFETIME_MS;
  const renewAt = renewalPoint(lifetimeMs);
  writeStorage(RENEW_AT_KEY, String(renewAt));
  return renewAt;
}

function sharedRefresh(apiUrl: string): Promise<number | null> {
  inFlight ??= performRefresh(apiUrl).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function lockTaken(): boolean {
  const until = Number(readStorage(LOCK_KEY)?.split(':')[1]);
  return Number.isFinite(until) && until > Date.now();
}

async function acquireLock(): Promise<boolean> {
  if (lockTaken()) return false;
  writeStorage(LOCK_KEY, `${tabId}:${Date.now() + LOCK_MS}`);
  // Varias pestañas pueden escribir a la vez: gana la última y el resto lo ve.
  await delay(LOCK_SETTLE_MS);
  return readStorage(LOCK_KEY)?.startsWith(`${tabId}:`) === true;
}

function releaseLock(): void {
  if (readStorage(LOCK_KEY)?.startsWith(`${tabId}:`)) writeStorage(LOCK_KEY, '');
}

/**
 * Garantiza una sesión fresca antes de llamar a la API. Todas las llamadas
 * concurrentes comparten el mismo refresco en vuelo.
 */
export async function ensureFreshSession(apiUrl = '/api'): Promise<boolean> {
  const renewAt = readNumber(RENEW_AT_KEY);
  if (renewAt !== null && Date.now() < renewAt) return true;
  try {
    return (await sharedRefresh(apiUrl)) !== null;
  } catch {
    return false;
  }
}

export function useSessionRefresh(
  { apiUrl = '/api', onExpired }: UseSessionRefreshOptions = {},
): SessionRefreshState {
  const [status, setStatus] = useState<SessionRefreshStatus>('idle');
  const failures = useRef(0);
  const unauthorized = useRef(0);
  const timer = useRef<number | null>(null);
  const expiredHandler = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    expiredHandler.current = onExpired;
  }, [onExpired]);

  useEffect(() => {
    let cancelled = false;

    const clearTimer = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };

    const schedule = (delayMs: number) => {
      clearTimer();
      timer.current = window.setTimeout(() => {
        void tick();
      }, Math.max(0, delayMs));
    };

    const giveUp = () => {
      writeStorage(RENEW_AT_KEY, '');
      setStatus('expired');
      const handler = expiredHandler.current;
      if (handler) {
        handler();
        return;
      }
      if (window.location.pathname !== '/') window.location.replace('/');
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (!navigator.onLine) {
        setStatus('offline');
        return;
      }

      const renewAt = readNumber(RENEW_AT_KEY);
      if (renewAt !== null && Date.now() < renewAt) {
        schedule(renewAt - Date.now());
        return;
      }

      if (inFlight === null && !(await acquireLock())) {
        if (cancelled) return;
        // Otra pestaña renueva; su resultado llega por el evento 'storage'.
        schedule(LOCK_MS + jitter());
        return;
      }

      setStatus('refreshing');
      try {
        const renewed = await sharedRefresh(apiUrl);
        if (cancelled) return;
        if (renewed === null) {
          failures.current += 1;
          unauthorized.current += 1;
          if (unauthorized.current >= MAX_UNAUTHORIZED) {
            giveUp();
            return;
          }
          setStatus('idle');
          schedule(backoff(failures.current));
          return;
        }
        failures.current = 0;
        unauthorized.current = 0;
        setStatus('idle');
        schedule(renewed - Date.now());
      } catch {
        if (cancelled) return;
        failures.current += 1;
        if (!navigator.onLine) {
          setStatus('offline');
          return;
        }
        setStatus('idle');
        schedule(backoff(failures.current));
      } finally {
        releaseLock();
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== RENEW_AT_KEY || cancelled) return;
      const renewAt = readNumber(RENEW_AT_KEY);
      if (renewAt === null) return;
      failures.current = 0;
      unauthorized.current = 0;
      setStatus('idle');
      schedule(renewAt - Date.now());
    };
    const onOnline = () => {
      failures.current = 0;
      schedule(0);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule(0);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    // Arranque desalineado: cinco pestañas abiertas a la vez no salen juntas.
    schedule(jitter());

    return () => {
      cancelled = true;
      clearTimer();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [apiUrl]);

  const refresh = useCallback(() => ensureFreshSession(apiUrl), [apiUrl]);

  return { status, refresh };
}
