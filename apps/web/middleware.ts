import { jwtVerify } from 'jose/jwt/verify';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const ROLE_PATHS = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  GUARDIA: 'guardia',
} as const;

export async function middleware(request: NextRequest) {
  const accessToken = request.cookies.get('voxia_access')?.value;
  const refreshToken = request.cookies.get('voxia_refresh')?.value;

  if (!accessToken && refreshToken) {
    const refreshed = await refreshSession(request, refreshToken);
    if (refreshed) return refreshed;
  }
  if (!accessToken) return clearSessionAndRedirect(request);

  const secret = process.env.JWT_SECRET;
  if (!secret) return NextResponse.redirect(new URL('/', request.url));

  try {
    const { payload } = await jwtVerify(accessToken, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: 'voxia-api',
      audience: 'voxia-clients',
    });
    const expectedPath = ROLE_PATHS[payload.role as keyof typeof ROLE_PATHS];
    if (!expectedPath) return NextResponse.redirect(new URL('/', request.url));

    const requestedRole = request.nextUrl.pathname.split('/')[2];
    if (requestedRole !== expectedPath) {
      return NextResponse.redirect(new URL(`/app/${expectedPath}`, request.url));
    }

    return NextResponse.next();
  } catch {
    if (refreshToken) {
      const refreshed = await refreshSession(request, refreshToken);
      if (refreshed) return refreshed;
    }
    return clearSessionAndRedirect(request);
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
        cookie: `voxia_refresh=${refreshToken}`,
        origin: new URL(webOrigin).origin,
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const redirect = NextResponse.redirect(request.nextUrl);
    const setCookie = response.headers.get('set-cookie');
    for (const cookie of setCookie?.split(/, (?=voxia_)/) ?? []) {
      redirect.headers.append('set-cookie', cookie);
    }
    return redirect;
  } catch {
    return null;
  }
}

function clearSessionAndRedirect(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/', request.url));
  response.cookies.delete('voxia_access');
  response.cookies.delete('voxia_refresh');
  return response;
}

export const config = {
  matcher: ['/app/:path*'],
};
