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
};

export default nextConfig;
