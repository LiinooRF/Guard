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

/**
 * Paquetes de la app, para la cabecera `X-Requested-With`.
 *
 * Android la pone el SISTEMA cuando el WebView navega, no la pagina, asi que
 * sirve de refuerzo cuando el user-agent llega recortado por un proveedor de
 * WebView. Misma regla que las marcas: la lista solo crece, porque el paquete
 * viejo sigue instalado en telefonos que nadie actualizo.
 */
export const PAQUETES_APP_GUARDIA = [
  'com.voxtilabs.sentrycore',
  'com.voxtilabs.voxiacontrol',
] as const;

/** Marcas aceptadas, de la más nueva a la más vieja. Solo se agregan. */
export const MARCAS_APP_GUARDIA = ['SentryCoreAndroid/', 'VoxIAAndroid/'] as const;

/** Si la petición viene de la app del guardia, con cualquier nombre histórico. */
export function esAppDelGuardia(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return MARCAS_APP_GUARDIA.some((marca) => userAgent.includes(marca));
}

/**
 * La misma pregunta del lado del servidor, mirando ademas `X-Requested-With`.
 *
 * SOLO se aceptan señales que ponga el sistema o la app: el user-agent y el
 * paquete. Una cabecera inventada por nosotros —o peor, una cookie— la puede
 * poner cualquiera desde la consola del navegador con una linea, y el carril
 * del guardia dejaria de ser el carril de la app: seria "el de quien sepa
 * escribir document.cookie". Que el user-agent tambien se pueda falsificar no
 * es motivo para agregar una puerta que se abre sin herramientas.
 */
export function peticionDeAppDelGuardia(cabeceras: {
  get(nombre: string): string | null;
}): boolean {
  if (esAppDelGuardia(cabeceras.get('user-agent'))) return true;
  const paquete = (cabeceras.get('x-requested-with') ?? '').trim().toLowerCase();
  return PAQUETES_APP_GUARDIA.some((esperado) => paquete === esperado);
}
