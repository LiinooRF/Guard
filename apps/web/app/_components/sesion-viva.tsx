'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { useSessionRefresh } from './use-session-refresh';

/**
 * Mantiene viva la sesión mientras el panel está abierto.
 *
 * `useSessionRefresh` existía, estaba bien escrito —candado en `localStorage`
 * para que dos pestañas no roten el token a la vez, renovación al 80% de la
 * vida— y **no lo montaba nadie**. Lo único que renovaba era
 * `ensureFreshSession`, y solo cuando la cola de sincronización tenía algo que
 * enviar.
 *
 * O sea que a quien no estaba enviando nada se le vencía el `voxia_access` a los
 * 15 minutos y la siguiente navegación lo echaba al login. Para un guardia en un
 * turno de 12 horas eso pasa decenas de veces: camina entre puntos sin nada que
 * sincronizar, y cuando llega al siguiente tiene que volver a escribir su clave
 * — si es que hay señal, porque en un subterráneo no la hay.
 *
 * Se comprobó en un teléfono real: la app quedó en `/app/guardia`, estuvo unos
 * minutos quieta, y termino sola en la pantalla de login.
 *
 * No pinta nada: su trabajo es que no pase nada.
 */
// Sin prop: el portal habla con la API en el MISMO origen (`/api`), que es
// justo el default del hook. Pasarla obligaria a exportar un helper que hoy
// vive dentro de una pagina.
export function SesionViva() {
  const router = useRouter();

  // Cuando ya no se puede renovar —el refresh vencio o lo revocaron— se
  // refresca la ruta y el middleware manda al login como corresponde. Es mejor
  // eso que dejar al usuario tocando botones que responden 401 en silencio.
  const alVencer = useCallback(() => router.refresh(), [router]);

  useSessionRefresh({ onExpired: alVencer });
  return null;
}
