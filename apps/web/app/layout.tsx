import type { Metadata, Viewport } from 'next';

import './globals.css';
import 'leaflet/dist/leaflet.css';

export const metadata: Metadata = {
  title: {
    default: 'SentryCore',
    template: '%s · SentryCore',
  },
  description:
    'SaaS multi-tenant de monitoreo de rondas de vigilancia con etiquetas NFC',
};

// El supervisor abre este panel tambien desde el celular, en terreno.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#111b32',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
