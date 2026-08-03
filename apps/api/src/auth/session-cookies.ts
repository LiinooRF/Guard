import type { CookieOptions, Response } from 'express';

import type { AuthenticatedSession } from './auth.types';

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Un solo lugar define nombre, flags y vida de las cookies de sesion. El
 * traspaso al WebView (#37) las emite por una ruta distinta al login: si cada
 * ruta arma sus propias opciones, un dia el WebView queda con una sesion de
 * duracion o SameSite diferente al del shell y nadie se entera.
 */
function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

export function setSessionCookies(response: Response, session: AuthenticatedSession): void {
  response.cookie('voxia_access', session.accessToken, {
    ...sessionCookieOptions(),
    maxAge: ACCESS_MAX_AGE_MS,
  });
  response.cookie('voxia_refresh', session.refreshToken, {
    ...sessionCookieOptions(),
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

export function clearSessionCookies(response: Response): void {
  response.clearCookie('voxia_access', { path: '/' });
  response.clearCookie('voxia_refresh', { path: '/' });
}
