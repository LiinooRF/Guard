import { consultarPermisoNotificaciones } from './permiso';
import type { ProveedorPushNativo } from './proveedor';

/**
 * Alta y baja del dispositivo contra la API.
 *
 * COMO SE AUTENTICA — igual que la subida de fotos del puente: el `fetch`
 * nativo de Android comparte el frasco de cookies del WebView
 * (`ForwardingCookieHandler`), asi que la sesion `HttpOnly` viaja sola y ningun
 * token de sesion queda expuesto al JavaScript del portal.
 *
 * POR QUE VA LA CABECERA `Origin` — la API protege las mutaciones con
 * `csrfOriginProtection`: acepta el `Origin` del portal, o una peticion nativa
 * SIN cookies. Esta peticion es nativa PERO lleva cookies (es lo que la
 * autentica), asi que cae entre las dos y sin `Origin` responderia 403.
 * Declararlo es correcto ademas conceptualmente: esta peticion nace de la app
 * que hospeda ese portal y de ninguna otra. Se manda tambien
 * `x-sentrycore-client: mobile` para que quede identificada en el log.
 */

/** Sin tope, un `fetch` en un subterraneo sin señal queda colgado para siempre. */
const TIMEOUT_MS = 10_000;

export type ResultadoRegistro =
  | 'registrado'
  | 'sin-permiso'
  | 'sin-token'
  /** Todavia no hay sesion en el WebView: se reintenta despues del login. */
  | 'sin-sesion'
  | 'error';

export interface OpcionesRegistro {
  /** Origen del portal, p.ej. `https://control.voxtilabs.cl`. */
  readonly portalOrigen: string;
  /** Base de la API, normalmente `${portalOrigen}/api`. */
  readonly apiBase: string;
  readonly appVersion: string;
  readonly proveedor: ProveedorPushNativo;
  /** Solo codigos. Nunca el token ni datos del guardia. */
  readonly registrar?: (evento: string, detalle?: string) => void;
}

async function pedir(
  opciones: OpcionesRegistro,
  ruta: string,
  init: { method: string; body?: string },
): Promise<Response> {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${opciones.apiBase}${ruta}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        'x-sentrycore-client': 'mobile',
        Origin: opciones.portalOrigen,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: control.signal,
    });
  } finally {
    clearTimeout(corte);
  }
}

/**
 * Registra el dispositivo. Es idempotente y esta pensado para llamarse cada vez
 * que la app abre y cada vez que el sistema rota el token: el servidor hace
 * upsert y refresca `last_seen_at`.
 *
 * NO PIDE EL PERMISO. Si no esta concedido devuelve `sin-permiso` y se queda
 * ahi: cuando y con que explicacion se pide es decision del portal, que es
 * quien tiene la pantalla y el contexto (ver permiso.ts).
 */
export async function registrarDispositivo(
  opciones: OpcionesRegistro,
): Promise<ResultadoRegistro> {
  const permiso = await consultarPermisoNotificaciones(opciones.proveedor);
  if (permiso.estado !== 'concedido') {
    opciones.registrar?.('push.sin-permiso', permiso.estado);
    return 'sin-permiso';
  }

  const token = await opciones.proveedor.obtenerToken();
  if (!token) {
    opciones.registrar?.('push.sin-token');
    return 'sin-token';
  }

  try {
    const respuesta = await pedir(opciones, '/push/devices', {
      method: 'POST',
      body: JSON.stringify({
        token,
        platform: 'android',
        appVersion: opciones.appVersion,
      }),
    });

    if (respuesta.status === 401) {
      // Normal en el arranque: el WebView todavia no inicio sesion. Quien
      // llama reintenta cuando el portal avise que hay sesion.
      opciones.registrar?.('push.sin-sesion');
      return 'sin-sesion';
    }
    if (!respuesta.ok) {
      opciones.registrar?.('push.registro-rechazado', String(respuesta.status));
      return 'error';
    }

    opciones.registrar?.('push.registrado');
    return 'registrado';
  } catch {
    // Sin red. No es una falla del producto: se reintenta al volver la señal.
    opciones.registrar?.('push.registro-sin-red');
    return 'error';
  }
}

/**
 * Baja del dispositivo. Se llama al CERRAR SESION, y es obligatorio: el
 * telefono de la empresa pasa de un turno al siguiente, y un token que sigue
 * apuntando al usuario anterior le hace sonar en el bolsillo alertas de un
 * recinto que ya no es suyo — con el detalle a un toque de distancia.
 *
 * El servidor responde igual si no habia nada que borrar, asi que reintentar
 * tras un corte de señal no produce errores.
 */
export async function darDeBajaDispositivo(opciones: OpcionesRegistro): Promise<boolean> {
  const token = await opciones.proveedor.obtenerToken();
  if (!token) return false;

  try {
    const respuesta = await pedir(
      opciones,
      `/push/devices/${encodeURIComponent(token)}`,
      { method: 'DELETE' },
    );
    opciones.registrar?.('push.baja', String(respuesta.status));
    return respuesta.ok;
  } catch {
    opciones.registrar?.('push.baja-sin-red');
    return false;
  }
}
