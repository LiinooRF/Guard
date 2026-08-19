/**
 * El código de empresa que queda fijado en ESTE teléfono.
 *
 * En la garita el guardia entra acercando la tarjeta. Si su cuenta cuelga de
 * más de una empresa, el servidor no puede saber a cuál, y hasta ahora le
 * mostraba una lista para elegir: un toque más, en un turno de noche, con
 * guantes. Fijar el código una sola vez elimina ese paso para siempre en ese
 * equipo.
 *
 * POR QUÉ `localStorage` Y NO EL PUENTE NATIVO
 * ---------------------------------------------------------------------------
 * Guardarlo del lado nativo sería más duro (sobrevive a limpiar los datos del
 * WebView), pero exigiría un mensaje nuevo del puente, y el puente solo lo
 * entienden los APK que se compilen DESPUÉS. El parque instalado —empezando por
 * el teléfono que hoy está en terreno— se quedaría sin la función hasta que
 * alguien actualice, que es la trampa que `app-del-guardia.ts` documenta con
 * el renombre a SentryCore.
 *
 * `localStorage` en el WebView de la app persiste entre cierres y reinicios, y
 * funciona con el APK que ya está instalado. Cuando se sume el mensaje al
 * puente (MINOR aditivo), este módulo es el único lugar que cambia: quien lo
 * usa no se entera.
 *
 * Lo que se guarda NO es un secreto —es el nombre corto de la empresa, el mismo
 * que el supervisor dicta por teléfono—, así que no pide cifrado. Sigue siendo
 * el servidor el que decide si esa cuenta pertenece a esa empresa.
 */

const CLAVE = 'sentrycore.codigo-empresa';

/** Mismo formato que exige la API (`CreateTenantDto`) para el slug. */
const FORMATO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * El teclado de un teléfono manda mayúscula inicial y a veces un espacio al
 * final. Rechazar por eso sería un enigma para el guardia, así que se normaliza
 * antes de validar en vez de devolverle un error.
 */
export function normalizarCodigoEmpresa(valor: string): string {
  return valor.trim().toLowerCase();
}

export function esCodigoEmpresaValido(valor: string): boolean {
  const normalizado = normalizarCodigoEmpresa(valor);
  return normalizado.length >= 3 && normalizado.length <= 48 && FORMATO.test(normalizado);
}

/**
 * Devuelve el código fijado, o cadena vacía si no hay ninguno.
 *
 * Nunca lanza: un `localStorage` inaccesible (modo privado, almacenamiento
 * bloqueado por política) tiene que degradar a "no hay código guardado" y
 * dejar que el guardia lo escriba, no tumbar la pantalla de ingreso.
 */
export function leerCodigoEmpresa(): string {
  try {
    const guardado = window.localStorage.getItem(CLAVE) ?? '';
    return esCodigoEmpresaValido(guardado) ? normalizarCodigoEmpresa(guardado) : '';
  } catch {
    return '';
  }
}

export function guardarCodigoEmpresa(valor: string): void {
  if (!esCodigoEmpresaValido(valor)) return;
  try {
    window.localStorage.setItem(CLAVE, normalizarCodigoEmpresa(valor));
  } catch {
    /* Sin almacenamiento se entra igual; solo se pierde el recordarlo. */
  }
}

export function olvidarCodigoEmpresa(): void {
  try {
    window.localStorage.removeItem(CLAVE);
  } catch {
    /* Ver arriba. */
  }
}
