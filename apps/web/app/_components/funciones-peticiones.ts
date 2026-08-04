/**
 * Llamadas a la API desde el navegador para la pantalla de funciones (#102).
 *
 * Siempre `credentials: 'include'`: la sesion viaja en cookies HttpOnly que el
 * JavaScript no puede leer, y sin esa opcion el servidor responde 401 aunque el
 * usuario este dentro.
 *
 * Nada se guarda en localStorage. Y nada de esto escribe logs: los mensajes de
 * error llevan solo lo que el servidor dijo, sin correos ni nombres de personas.
 */

/**
 * Mensaje del servidor en palabras. Se prefiere SIEMPRE el del backend: cuando
 * el plan no incluye un modulo, o cuando una regla quedo fuera de rango, ese
 * texto nombra exactamente el modulo o el parametro y el nuestro no podria.
 */
export async function mensajeDeErrorApi(respuesta: Response): Promise<string> {
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    if (Array.isArray(datos.message) && datos.message.length) return datos.message.join('. ');
    if (typeof datos.message === 'string' && datos.message) return datos.message;
  } catch {
    // Sin cuerpo util: cae a los textos genericos de abajo.
  }
  if (respuesta.status === 401) return 'Tu sesión venció. Vuelve a entrar y reintenta.';
  if (respuesta.status === 403) return 'Tu cuenta no puede cambiar esta configuración.';
  if (respuesta.status === 404) return 'Esa configuración ya no está disponible.';
  return 'No fue posible completar la operación.';
}

/** GET autenticado. Devuelve `alternativa` en vez de lanzar: la pantalla se pinta igual. */
export async function pedirJson<T>(apiUrl: string, ruta: string, alternativa: T): Promise<T> {
  return (await pedirJsonConEstado(apiUrl, ruta, alternativa)).datos;
}

/**
 * Igual que `pedirJson`, pero ademas dice si la consulta funciono.
 *
 * Hace falta cuando "vino vacio" y "no se pudo preguntar" significan cosas
 * distintas para el usuario: un historial sin movimientos es una empresa que
 * todavia no cambio nada, y uno que fallo es un problema que hay que reintentar.
 */
export async function pedirJsonConEstado<T>(
  apiUrl: string,
  ruta: string,
  alternativa: T,
): Promise<{ ok: boolean; datos: T }> {
  try {
    const respuesta = await fetch(`${apiUrl}${ruta}`, { credentials: 'include' });
    if (!respuesta.ok) return { ok: false, datos: alternativa };
    return { ok: true, datos: (await respuesta.json()) as T };
  } catch {
    return { ok: false, datos: alternativa };
  }
}
