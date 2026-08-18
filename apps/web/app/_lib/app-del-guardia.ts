/**
 * Cómo se reconoce a la app del guardia por su user-agent.
 *
 * El carril del GUARDIA es la app: el middleware lo saca del navegador y la
 * pantalla de login le niega la entrada si no viene de ahí. Esa comprobación
 * mira una marca que la app pone en su user-agent
 * (`applicationNameForUserAgent` en `apps/mobile/App.tsx`).
 *
 * **La marca vieja no se borra nunca, aunque el producto cambie de nombre.**
 * El renombre a SentryCore cambió la marca a `SentryCoreAndroid/` en el mismo
 * commit en los dos lados, y en el repositorio eso se ve consistente — pero el
 * teléfono de un guardia NO se actualiza con un deploy. Cada APK ya instalado
 * sigue diciendo `VoxIAAndroid/`, así que al desplegar el renombre todos ellos
 * dejaron de poder entrar: el login los echaba con «el acceso de guardia está
 * disponible únicamente en la app Android» y el middleware les borraba la
 * sesión. Sin salida posible desde el teléfono, porque el problema estaba en el
 * servidor.
 *
 * Es la trampa que `CLAUDE.md` ya advierte en «Versiona el protocolo del
 * puente»: los usuarios tardan semanas en actualizar, y un cambio incompatible
 * del lado web les rompe la app en producción. La regla práctica: esta lista
 * solo CRECE. Agregar una marca es gratis; quitar una deja a gente en terreno
 * sin poder trabajar.
 */

/** Marcas aceptadas, de la más nueva a la más vieja. Solo se agregan. */
export const MARCAS_APP_GUARDIA = ['SentryCoreAndroid/', 'VoxIAAndroid/'] as const;

/** Si la petición viene de la app del guardia, con cualquier nombre histórico. */
export function esAppDelGuardia(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return MARCAS_APP_GUARDIA.some((marca) => userAgent.includes(marca));
}
