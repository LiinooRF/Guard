/**
 * Contrato del deep link de una notificacion push de VoxIA Control (#113).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE CONTRATO ESTA VERSIONADO
 * ---------------------------------------------------------------------------
 * Por la MISMA razon que el puente postMessage (`apps/mobile/src/bridge/
 * protocol.ts`): los dos extremos se despliegan a velocidades incompatibles.
 *
 *   - El servidor que ARMA el payload se despliega en minutos y se revierte en
 *     minutos.
 *   - El shell que LO INTERPRETA pasa por revision de Play Store y despues
 *     depende de que cada guardia actualice. Semanas, no minutos. Y no se
 *     revierte: la version publicada queda instalada en telefonos que no
 *     controlamos.
 *
 * Consecuencia: el servidor puede empezar a mandar un destino que el shell
 * instalado no conoce, y eso pasa el dia del deploy, no en un caso raro. La
 * regla dura es entonces:
 *
 *   **Un payload que el shell no entiende NUNCA rompe la notificacion.**
 *   Se degrada a `inicio` y el usuario igual entra al portal. Una alerta de
 *   panico que no abre nada al tocarla es peor que una que abre la pantalla
 *   equivocada.
 *
 *   MAJOR sube cuando un destino existente cambia de forma o desaparece.
 *   MINOR sube cuando se AGREGA un destino o un campo opcional (no rompe).
 *
 * ---------------------------------------------------------------------------
 * POR QUE EL PAYLOAD LLEVA UN DESTINO Y NO UNA URL
 * ---------------------------------------------------------------------------
 * Mandar la ruta ya armada desde el servidor haria que los shells viejos
 * siguieran rutas nuevas sin actualizar, que suena mejor. Se descarto por dos
 * razones concretas:
 *
 * 1. Es un redirector abierto dentro de la sesion del WebView: quien pueda
 *    emitir un push (el proveedor, o cualquiera con sus credenciales) elegiria
 *    que URL abre la app con las cookies del supervisor puestas.
 * 2. El shell necesita saber QUE es, no solo donde ir: un panico justifica
 *    sonido propio y canal de notificacion de alta prioridad; una ronda vencida
 *    no. Con una URL opaca esa decision no se puede tomar.
 *
 * ---------------------------------------------------------------------------
 * ESTE ARCHIVO NO IMPORTA NADA
 * ---------------------------------------------------------------------------
 * Ni Node, ni React Native, ni el DOM. Es el MISMO archivo en la API
 * (`apps/api/src/push/deep-link.ts`) y en el shell
 * (`apps/mobile/src/push/deep-link.ts`), copiado tal cual, porque `apps/mobile`
 * esta fuera de los workspaces de npm y no puede importar `@voxia/shared`. Si
 * le agregas un import, deja de poder copiarse y los dos lados se desincronizan
 * en silencio — que es exactamente lo que este archivo existe para evitar. La
 * verificacion en CI esta propuesta en INTEGRACION.md.
 */

/** Version que habla ESTE build. */
export const DEEP_LINK_MAJOR = 1;
export const DEEP_LINK_MINOR = 0;

/**
 * Mayores que este build todavia entiende. Se agrega la anterior al subir de
 * mayor y se retira cuando las metricas de Play muestran que el parque migro.
 */
export const DEEP_LINK_MAJORS_SOPORTADOS: readonly number[] = [1];

/**
 * Destinos de la v1.
 *
 *   evento — la bandeja de ESE evento (el panico es criticidad, no otra cosa)
 *   ronda  — la ronda concreta (vencida, o con anomalias)
 *   inicio — el portal, sin mas. Es tambien el degradado de todo lo que no se
 *            entienda: nunca se adivina un destino.
 */
export const DESTINOS_DEEP_LINK = ['evento', 'ronda', 'inicio'] as const;
export type DestinoDeepLink = (typeof DESTINOS_DEEP_LINK)[number];

export interface DeepLink {
  readonly destino: DestinoDeepLink;
  /** Id del evento o de la ronda. Ausente en `inicio`. */
  readonly id?: string;
  /** Recinto, para que el portal pueda encuadrar sin una consulta extra. */
  readonly siteId?: string;
}

/**
 * Rutas del portal. Son parte del contrato: las arma el shell instalado, asi
 * que cambiar una es un MAJOR, no un ajuste de routing.
 *
 * Deliberadamente SIN el rol en la ruta (`/app/supervisor/...`): el mismo aviso
 * le puede llegar al ADMIN y al SUPERVISOR, y el portal ya sabe redirigir por
 * rol. Meter el rol aca obligaria al servidor a saber que rol tiene cada
 * destinatario para armar la ruta, y a acertarle desde una version anterior.
 */
export const RUTAS_DEEP_LINK = {
  evento: '/app/eventos',
  ronda: '/app/rondas',
  inicio: '/app',
} as const;

/** Claves del payload plano. Se congelan con el MAJOR. */
export const CLAVE_VERSION = 'dl';
export const CLAVE_DESTINO = 'destino';
export const CLAVE_ID = 'id';
export const CLAVE_SITE = 'siteId';

export type MotivoDegradado =
  | 'sin-payload'
  | 'version-no-soportada'
  | 'destino-desconocido'
  | 'referencia-invalida';

export type LecturaDeepLink =
  | { readonly ok: true; readonly deepLink: DeepLink }
  | {
      readonly ok: false;
      readonly motivo: MotivoDegradado;
      /** Siempre navegable: el degradado es parte del contrato, no un error. */
      readonly deepLink: DeepLink;
    };

const INICIO: DeepLink = { destino: 'inicio' };

/**
 * Serializa a lo unico que un transporte push acepta: pares de strings.
 *
 * No es una preferencia de estilo — FCM entrega el bloque `data` como
 * `Map<String, String>` y convierte en silencio cualquier otra cosa. Un numero
 * o un booleano vuelven como `"1"` / `"true"` del otro lado, asi que aca se
 * escriben strings a proposito y no se anida nada.
 *
 * Lo que NO va: nombres, correos, texto de la novedad ni coordenadas. El payload
 * viaja por un tercero y se muestra en una pantalla bloqueada que puede estar
 * sobre una mesa. Todo el detalle vive detras de la sesion, en el portal.
 */
export function datosDeDeepLink(deepLink: DeepLink): Record<string, string> {
  const datos: Record<string, string> = {
    [CLAVE_VERSION]: String(DEEP_LINK_MAJOR),
    [CLAVE_DESTINO]: deepLink.destino,
  };
  if (deepLink.id !== undefined) datos[CLAVE_ID] = deepLink.id;
  if (deepLink.siteId !== undefined) datos[CLAVE_SITE] = deepLink.siteId;
  return datos;
}

/**
 * Formato de las referencias que se aceptan. Es la unica validacion de
 * contenido del contrato y esta aca por seguridad, no por prolijidad: el `id`
 * termina concatenado en una ruta que el WebView abre con la sesion del
 * supervisor puesta. Restringido a UUID no hay forma de meter `../`, `?`, `#`
 * ni un `//host` que cambie el origen.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(datos: Record<string, unknown>, clave: string): string | undefined {
  const valor = datos[clave];
  return typeof valor === 'string' && valor.length > 0 ? valor : undefined;
}

/**
 * Lee el payload recibido. NUNCA falla: devuelve siempre un `deepLink`
 * navegable y, cuando hubo que degradar, el motivo para registrarlo.
 *
 * El motivo importa en operacion: `version-no-soportada` significa que hay
 * telefonos con un shell anterior al deploy y que ese contrato todavia no se
 * puede retirar.
 */
export function leerDeepLink(datos: Record<string, unknown> | null | undefined): LecturaDeepLink {
  if (!datos) {
    return { ok: false, motivo: 'sin-payload', deepLink: INICIO };
  }

  const version = Number(texto(datos, CLAVE_VERSION) ?? '');
  if (!DEEP_LINK_MAJORS_SOPORTADOS.includes(version)) {
    return { ok: false, motivo: 'version-no-soportada', deepLink: INICIO };
  }

  const destino = texto(datos, CLAVE_DESTINO);
  if (destino === undefined || !(DESTINOS_DEEP_LINK as readonly string[]).includes(destino)) {
    return { ok: false, motivo: 'destino-desconocido', deepLink: INICIO };
  }

  const id = texto(datos, CLAVE_ID);
  const siteId = texto(datos, CLAVE_SITE);

  if (destino === 'inicio') {
    return { ok: true, deepLink: INICIO };
  }
  if (id === undefined || !UUID.test(id)) {
    return { ok: false, motivo: 'referencia-invalida', deepLink: INICIO };
  }
  if (siteId !== undefined && !UUID.test(siteId)) {
    return { ok: false, motivo: 'referencia-invalida', deepLink: INICIO };
  }

  return {
    ok: true,
    deepLink: {
      destino: destino as DestinoDeepLink,
      id,
      ...(siteId === undefined ? {} : { siteId }),
    },
  };
}

/**
 * Ruta relativa del portal. Relativa a proposito: el origen lo pone el shell
 * desde su propia configuracion (`EXPO_PUBLIC_WEB_URL`) y no el payload, para
 * que una notificacion no pueda mandar la sesion a otro dominio.
 */
export function rutaDePortal(deepLink: DeepLink): string {
  if (deepLink.destino === 'inicio' || deepLink.id === undefined) {
    return RUTAS_DEEP_LINK.inicio;
  }
  return `${RUTAS_DEEP_LINK[deepLink.destino]}/${deepLink.id}`;
}

/** Atajos que usan el servidor al armar el aviso y el shell al probarlo. */
export function deepLinkDeEvento(eventId: string, siteId: string): DeepLink {
  return { destino: 'evento', id: eventId, siteId };
}

export function deepLinkDeRonda(patrolId: string, siteId: string): DeepLink {
  return { destino: 'ronda', id: patrolId, siteId };
}
