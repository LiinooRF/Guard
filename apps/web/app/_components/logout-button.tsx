'use client';

import { useState } from 'react';

import { crearClientePuente } from '../_lib/bridge/web-client';

export function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? '/api'}/auth/logout`,
        {
          method: 'POST',
          credentials: 'include',
        },
      ).catch(() => undefined);
    } finally {
      try {
        const puente = crearClientePuente();
        const estado = await puente.conectar().catch(() => undefined);
        if (estado?.clase === 'listo' && estado.info.protocolo.minor >= 1) {
          await puente.borrarRutaOffline().catch(() => undefined);
        }
        puente.desconectar();
      } catch {
        // Ignorar fallos de puente durante logout
      }
      if (typeof window !== 'undefined') {
        window.location.replace('/');
      }
    }
  }

  return (
    <button className="secondary-button" disabled={loading} onClick={logout} type="button">
      {loading ? 'Saliendo…' : 'Cerrar sesión'}
    </button>
  );
}
