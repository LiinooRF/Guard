import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Desarrollo y build no pueden compartir artefactos: `next build` reemplaza
  // manifests y vendor chunks mientras `next dev` todavía los tiene abiertos.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  output: 'standalone',
  // Incluye el workspace compartido en el trazado de la imagen standalone.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),

  // @sentrycore/shared es un paquete del workspace sin publicar: Next tiene que
  // transpilarlo en vez de tratarlo como dependencia externa ya compilada.
  transpilePackages: ['@sentrycore/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), geolocation=(self), microphone=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
