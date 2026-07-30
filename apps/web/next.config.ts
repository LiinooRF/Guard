import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // @voxia/shared es un paquete del workspace sin publicar: Next tiene que
  // transpilarlo en vez de tratarlo como dependencia externa ya compilada.
  transpilePackages: ['@voxia/shared'],
};

export default nextConfig;
