import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { esAppDelGuardia } from './app/_lib/app-del-guardia';

const ROLE_PATHS = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  GUARDIA: 'guardia',
} as const;

export async function middleware(request: NextRequest) {
  const accessToken = request.cookies.get('sentrycore_access')?.value;
  const refreshToken = request.cookies.get('sentrycore_refresh')?.value;

  if (!accessToken && refreshToken) {
    const refreshed = await refreshSession(request, refreshToken);
    if (refreshed) return refreshed;
  }
  if (!accessToken) return clearSessionAndRedirect(request);

  const role = await resolveSession(request, accessToken);
  if (role) {
    if (role === 'GUARDIA' && !esAppDelGuardia(request.headers.get('user-agent'))) {
      return clearSessionAndRedirect(request);
    }

    const expectedPath = ROLE_PATHS[role];

    const requestedRole = request.nextUrl.pathname.split('/')[2];
    if (requestedRole !== expectedPath) {
      return NextResponse.redirect(new URL(`/app/${expectedPath}`, request.url));
    }

    return NextResponse.next();
  }

  if (refreshToken) {
    const refreshed = await refreshSession(request, refreshToken);
    if (refreshed) return refreshed;
  }
  return clearSessionAndRedirect(request);
}

async function resolveSession(
  request: NextRequest,
  accessToken: string,
): Promise<keyof typeof ROLE_PATHS | null> {
  const apiUrl = process.env.API_INTERNAL_URL;
  if (!apiUrl) return null;

  try {
    const response = await fetch(`${apiUrl}/auth/session`, {
      headers: {
        cookie: `sentrycore_access=${accessToken}`,
        'x-request-id': request.headers.get('x-request-id') ?? crypto.randomUUID(),
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const result = (await response.json()) as {
      user?: { role?: string } | null;
    };
    return result.user?.role && result.user.role in ROLE_PATHS
      ? (result.user.role as keyof typeof ROLE_PATHS)
      : null;
  } catch {
    return null;
  }
}

async function refreshSession(request: NextRequest, refreshToken: string) {
  const apiUrl = process.env.API_INTERNAL_URL;
  const webOrigin = process.env.WEB_PUBLIC_URL;
  if (!apiUrl || !webOrigin) return null;

  try {
    const response = await fetch(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: `sentrycore_refresh=${refreshToken}`,
        origin: new URL(webOrigin).origin,
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const redirect = NextResponse.redirect(request.nextUrl);
    const setCookie = response.headers.get('set-cookie');
    for (const cookie of setCookie?.split(/, (?=sentrycore_)/) ?? []) {
      redirect.headers.append('set-cookie', cookie);
    }
    return redirect;
  } catch {
    return null;
  }
}

function clearSessionAndRedirect(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/', request.url));
  response.cookies.delete('sentrycore_access');
  response.cookies.delete('sentrycore_refresh');
  return response;
}

export const config = {
  matcher: ['/app/:path*'],
};
