'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { crearClientePuente } from '../_lib/bridge/web-client';

export function LogoutButton() {
  const router = useRouter();
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
      );
      const puente = crearClientePuente();
      const estado = await puente.conectar().catch(() => undefined);
      if (estado?.clase === 'listo' && estado.info.protocolo.minor >= 1) {
        await puente.borrarRutaOffline().catch(() => undefined);
      }
      puente.desconectar();
    } finally {
      router.push('/');
      router.refresh();
    }
  }

  return (
    <button className="secondary-button" disabled={loading} onClick={logout} type="button">
      {loading ? 'Saliendo…' : 'Cerrar sesión'}
    </button>
  );
}
