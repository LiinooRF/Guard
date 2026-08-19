import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { LoginScreen } from './_components/login-screen';
import { peticionDeAppDelGuardia } from './_lib/app-del-guardia';

/**
 * La portada manda al panel cuando la sesion sigue viva.
 *
 * POR QUE EXISTE ESTO, que parecia un detalle y no lo era: la app del guardia
 * abre SIEMPRE la raiz (`EXPO_PUBLIC_WEB_URL`, sin ruta). Esta pagina devolvia
 * el formulario de acceso sin mirar la sesion —y el middleware ni siquiera
 * corre aca, su matcher es `/app/:path*`—, asi que **cada arranque en frio de
 * la app terminaba en el login aunque la sesion estuviera perfecta**.
 *
 * Se diagnostico como si fuera un problema de cookies: el guardia volvia al
 * login despues de que Android matara el proceso, y con Home + reabrir no
 * pasaba. La diferencia no eran las cookies —medido: con la sesion valida,
 * `/app/guardia` responde 200 y la raiz respondia 200 con el formulario—, sino
 * que al matar el proceso el WebView pierde su URL y vuelve a la raiz, mientras
 * que al reabrirlo sin matarlo conserva `/app/guardia`.
 *
 * El GUARDIA se redirige SOLO si la peticion viene de la app. Desde un
 * navegador el middleware lo echaria igual, asi que mandarlo alli seria pasearlo
 * para devolverlo al mismo lugar; ve el login, que es su carril correcto.
 */
const RUTA_POR_ROL = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  GUARDIA: 'guardia',
} as const;

type Rol = keyof typeof RUTA_POR_ROL;

async function rolDeLaSesion(accessToken: string, requestId: string): Promise<Rol | null> {
  const apiUrl = process.env.API_INTERNAL_URL;
  if (!apiUrl) return null;
  try {
    const respuesta = await fetch(`${apiUrl}/auth/session`, {
      headers: { cookie: `sentrycore_access=${accessToken}`, 'x-request-id': requestId },
      cache: 'no-store',
    });
    if (!respuesta.ok) return null;
    const datos = (await respuesta.json()) as { user?: { role?: string } | null };
    const rol = datos.user?.role;
    return rol && rol in RUTA_POR_ROL ? (rol as Rol) : null;
  } catch {
    // Sin API no se adivina: se muestra el login, que es el estado seguro.
    return null;
  }
}

export default async function Home() {
  const cabeceras = await headers();
  const galleta = await cookies();
  const accessToken = galleta.get('sentrycore_access')?.value;

  if (accessToken) {
    const rol = await rolDeLaSesion(
      accessToken,
      cabeceras.get('x-request-id') ?? crypto.randomUUID(),
    );
    // El refresh NO se intenta aca: renovar es escribir cookies, y una pagina de
    // servidor no puede. Con el access vencido cae al login, y ahi el guardia
    // vuelve a entrar; el caso que este arreglo resuelve —sesion viva, arranque
    // en frio— es el que se daba todo el tiempo.
    if (rol && (rol !== 'GUARDIA' || peticionDeAppDelGuardia(cabeceras))) {
      redirect(`/app/${RUTA_POR_ROL[rol]}`);
    }
  }

  return <LoginScreen />;
}
