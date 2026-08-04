import type { PushProvider } from './push-provider';

/**
 * Adaptador de FCM — DECLARADO, NO IMPLEMENTADO. Ver #113.
 *
 * Existe para dejar escrito el contrato y las variables que hacen falta, sin
 * arrastrar hoy la dependencia de `firebase-admin` ni una cuenta de servicio a
 * un repositorio donde la decision de proveedor sigue abierta (CLAUDE.md,
 * "Decisiones abiertas"). Mismo criterio que con el correo: el codigo va contra
 * el puerto y el adaptador se escribe el dia que se decide.
 *
 * ---------------------------------------------------------------------------
 * VARIABLES DE ENTORNO (ver apps/api/src/config/env.ts)
 * ---------------------------------------------------------------------------
 *   PUSH_DRIVER=fcm      activa este adaptador. Con `log` (default) no se manda
 *                        nada a internet.
 *   FCM_PROJECT_ID       id del proyecto de Firebase. Aparece en la URL de la
 *                        consola y en el JSON de la cuenta de servicio.
 *   FCM_CLIENT_EMAIL     `client_email` de la cuenta de servicio.
 *   FCM_PRIVATE_KEY      `private_key` de la cuenta de servicio. ES UN SECRETO:
 *                        va en el gestor de secretos de Dokploy, nunca en el
 *                        repositorio ni en el .env de ejemplo. Viaja con `\n`
 *                        escapados, asi que hay que desescaparlos al leerla.
 *
 * La cuenta de servicio solo necesita el rol "Firebase Cloud Messaging API
 * Admin". Con permisos de mas, una filtracion de esa clave alcanza para tocar
 * otros servicios del proyecto.
 *
 * ---------------------------------------------------------------------------
 * LO QUE TIENE QUE HACER EL DIA QUE SE IMPLEMENTE
 * ---------------------------------------------------------------------------
 * 1. HTTP v1 (`/v1/projects/{id}/messages:send`), no la API legacy: la legacy
 *    esta discontinuada y su "server key" se filtra con solo mirar el codigo
 *    del cliente.
 * 2. Un mensaje POR TOKEN. HTTP v1 no tiene envio multicast propio; el SDK lo
 *    simula con un lote de requests. El puerto ya pide un veredicto por token,
 *    asi que eso encaja sin cambiar nada.
 * 3. El deep link va en `data` (pares de strings, ver deep-link.ts) y NO en
 *    `notification`. Si el aviso viaja como `notification` y la app esta en
 *    segundo plano, lo muestra el sistema y la app NO ejecuta codigo: se pierde
 *    el manejo del deep link y el canal de alta prioridad. Con `data` decide la
 *    app.
 * 4. `android.priority = 'high'` cuando `urgency === 'alta'`, y ademas un canal
 *    de notificacion propio del lado del shell: sin canal de alta importancia,
 *    Android 8+ muestra el panico en silencio.
 * 5. `android.ttl` corto para lo urgente: un panico entregado dos horas despues
 *    desinforma. Que ese numero salga de una regla del tenant si el negocio lo
 *    pide (RulesService), no de una constante nueva.
 *
 * TRADUCCION DE ERRORES AL PUERTO — es el punto que no se puede improvisar:
 *
 *   UNREGISTERED           -> 'token-invalido'  (desinstalo o borro datos)
 *   INVALID_ARGUMENT       -> 'token-invalido'  (token malformado o de otra app)
 *   SENDER_ID_MISMATCH     -> 'token-invalido'  (token de otro proyecto)
 *   UNAVAILABLE, INTERNAL  -> 'reintentable'    (5xx del proveedor)
 *   QUOTA_EXCEEDED         -> 'reintentable'    (respetar el Retry-After)
 *   THIRD_PARTY_AUTH_ERROR -> 'reintentable'    (no es culpa del dispositivo)
 *
 * Todo lo que no este en esa lista se trata como 'reintentable'. Borrar por un
 * codigo desconocido deja al supervisor sin telefono registrado justo despues
 * de un incidente del proveedor, y nadie se entera hasta el siguiente panico.
 */
export interface FcmProviderOptions {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

/**
 * Falla al construirse, no al primer envio. Mismo criterio que la validacion de
 * entorno: una API que arranca a medias y descubre en el primer panico que no
 * sabe mandar nada es mucho peor que una que se niega a arrancar diciendo por
 * que.
 */
export function createFcmProvider(options: FcmProviderOptions): PushProvider {
  throw new Error(
    `PUSH_DRIVER=fcm todavia no tiene adaptador (proyecto ${options.projectId}): el proveedor ` +
      'de push no esta decidido (#113). Usa PUSH_DRIVER=log o implementa createFcmProvider ' +
      'siguiendo la traduccion de errores documentada en apps/api/src/push/fcm.provider.ts',
  );
}
