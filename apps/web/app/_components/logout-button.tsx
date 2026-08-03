'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
