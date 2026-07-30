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

  // Las rutas /demo siguen disponibles como vista previa sin sesión.
  if (!accessToken) return NextResponse.next();

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
      return NextResponse.redirect(new URL(`/demo/${expectedPath}`, request.url));
    }

    return NextResponse.next();
  } catch {
    const response = NextResponse.redirect(new URL('/', request.url));
    response.cookies.delete('voxia_access');
    response.cookies.delete('voxia_refresh');
    return response;
  }
}

export const config = {
  matcher: ['/demo/:path*'],
};
