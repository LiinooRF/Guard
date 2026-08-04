'use client';

import type { EncolarSyncPayload } from '../_lib/bridge/protocol';
import { crearClientePuente } from '../_lib/bridge/web-client';

let conexion: ReturnType<typeof crearClientePuente> | undefined;
let preparada: Promise<ReturnType<typeof crearClientePuente> | undefined> | undefined;
let escritura: Promise<unknown> = Promise.resolve();

async function clienteNativo() {
  conexion ??= crearClientePuente();
  preparada ??= conexion.conectar()
    .then((estado) => estado.clase === 'listo' && estado.info.protocolo.minor >= 2
      ? conexion
      : undefined)
    .catch(() => undefined);
  return preparada;
}

/**
 * Espeja la operación en la cola SQLCipher del shell. localStorage sigue siendo
 * el respaldo para navegador/escritorio; reenviar desde ambos lados es seguro
 * porque comparten exactamente el mismo clientId.
 */
export async function reflejarEnColaNativa(
  apiUrl: string,
  operation: EncolarSyncPayload['operation'],
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const guardar = escritura.then(async () => {
    const cliente = await clienteNativo();
    if (!cliente) return false;
    const absoluta = new URL(apiUrl, window.location.origin).href.replace(/\/$/, '');
    return cliente.encolarSync({
      apiUrl: absoluta,
      portalOrigin: window.location.origin,
      operation,
    });
  });
  escritura = guardar.catch(() => undefined);
  return guardar;
}
