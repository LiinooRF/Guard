'use client';

/**
 * Almacenamiento local de la pantalla del guardia.
 *
 * Guarda TRABAJO OPERATIVO —escaneos y novedades que todavía no llegaron al
 * servidor— y nunca credenciales: las cookies de sesión son HttpOnly y siguen
 * fuera del alcance del JavaScript. Sin esto, cerrar el WebView en medio de una
 * ronda en un subterráneo borra lo que el guardia ya hizo.
 *
 * El WebView puede tener el almacenamiento bloqueado por política del
 * dispositivo. En ese caso se sigue funcionando en memoria: perder la cola al
 * cerrar la app es malo, pero romper la pantalla en terreno es peor.
 */

export function leerJson<T>(clave: string, porDefecto: T): T {
  if (typeof window === 'undefined') return porDefecto;
  try {
    const crudo = window.localStorage.getItem(clave);
    if (crudo === null) return porDefecto;
    return JSON.parse(crudo) as T;
  } catch {
    // JSON corrupto o almacenamiento bloqueado: se arranca limpio.
    return porDefecto;
  }
}

export function escribirJson(clave: string, valor: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Cuota llena o almacenamiento bloqueado: se continúa sin persistencia.
  }
}

export function borrarClave(clave: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(clave);
  } catch {
    // Ver escribirJson.
  }
}

/**
 * UUID v4 para las claves de idempotencia (`clientScanId`, `clientEventId`).
 *
 * El servidor las valida con `@IsUUID()`, así que un identificador cualquiera
 * haría que la operación se rechace justo cuando el guardia está sin señal y no
 * puede enterarse. `crypto.randomUUID` no existe fuera de contexto seguro ni en
 * WebViews antiguos, de ahí el respaldo armado a mano.
 */
export function nuevoUuid(): string {
  const cripto: Crypto | undefined = globalThis.crypto;
  if (typeof cripto?.randomUUID === 'function') return cripto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cripto?.getRandomValues === 'function') {
    cripto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
