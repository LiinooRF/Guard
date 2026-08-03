import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Incluye el workspace compartido en el trazado de la imagen standalone.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),

  // @voxia/shared es un paquete del workspace sin publicar: Next tiene que
  // transpilarlo en vez de tratarlo como dependencia externa ya compilada.
  transpilePackages: ['@voxia/shared'],
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
