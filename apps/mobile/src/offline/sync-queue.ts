import { abrirBaseOperativa } from './route-store';

export interface OperacionSyncNativa {
  readonly type: 'scan' | 'event';
  readonly clientId: string;
  readonly patrolId?: string;
  readonly payload: Record<string, unknown>;
  readonly queuedAt: string;
}

export interface EncolarSyncPayload {
  readonly apiUrl: string;
  readonly portalOrigin: string;
  readonly operation: OperacionSyncNativa;
}

interface FilaCola {
  sequence: number;
  client_id: string;
  api_url: string;
  portal_origin: string;
  operation_json: string;
  attempts: number;
}

interface Veredicto {
  clientId: string;
  status: 'aplicado' | 'duplicado' | 'rechazado';
  reason?: string;
}

const BATCH = 200;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60 * 60 * 1_000;

export async function encolarOperacion(payload: EncolarSyncPayload): Promise<boolean> {
  const db = await abrirBaseOperativa();
  const resultado = await db.runAsync(
    `INSERT INTO sync_queue (
       client_id, api_url, portal_origin, operation_json, queued_at, next_attempt_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO NOTHING`,
    payload.operation.clientId,
    payload.apiUrl.replace(/\/$/, ''),
    payload.portalOrigin,
    JSON.stringify(payload.operation),
    payload.operation.queuedAt,
    new Date().toISOString(),
  );
  return resultado.changes === 1;
}

async function enviar(
  apiUrl: string,
  portalOrigin: string,
  operaciones: readonly OperacionSyncNativa[],
): Promise<Response> {
  const pedido = () => fetch(`${apiUrl}/sync/push`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Voxia-Request': 'mobile-background',
      'X-Voxia-Client': 'mobile',
      Origin: portalOrigin,
    },
    body: JSON.stringify({ operations: operaciones }),
  });
  let respuesta = await pedido();
  if (respuesta.status !== 401) return respuesta;
  const refresco = await fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Voxia-Client': 'mobile', Origin: portalOrigin },
  });
  if (refresco.ok) respuesta = await pedido();
  return respuesta;
}

async function empujar(
  apiUrl: string,
  portalOrigin: string,
  operaciones: readonly OperacionSyncNativa[],
): Promise<Veredicto[]> {
  const respuesta = await enviar(apiUrl, portalOrigin, operaciones);
  if (respuesta.status === 413 && operaciones.length > 1) {
    const mitad = Math.ceil(operaciones.length / 2);
    return [
      ...await empujar(apiUrl, portalOrigin, operaciones.slice(0, mitad)),
      ...await empujar(apiUrl, portalOrigin, operaciones.slice(mitad)),
    ];
  }
  if (!respuesta.ok) throw new Error(`sync_${respuesta.status}`);
  const cuerpo = (await respuesta.json()) as { results?: Veredicto[] };
  return cuerpo.results ?? [];
}

function proximoIntento(intentos: number): string {
  const espera = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(intentos, 20), BACKOFF_MAX_MS);
  return new Date(Date.now() + espera).toISOString();
}

let sincronizacionActiva: Promise<{ procesadas: number; pendientes: number }> | undefined;

export function sincronizarCola(): Promise<{ procesadas: number; pendientes: number }> {
  sincronizacionActiva ??= ejecutarSincronizacion().finally(() => {
    sincronizacionActiva = undefined;
  });
  return sincronizacionActiva;
}

async function ejecutarSincronizacion(): Promise<{ procesadas: number; pendientes: number }> {
  const db = await abrirBaseOperativa();
  const filas = await db.getAllAsync<FilaCola>(
    `SELECT sequence, client_id, api_url, portal_origin, operation_json, attempts
     FROM sync_queue
     WHERE state = 'pendiente' AND next_attempt_at <= ?
     ORDER BY queued_at ASC, sequence ASC LIMIT ?`,
    new Date().toISOString(),
    BATCH,
  );
  if (!filas.length) return { procesadas: 0, pendientes: 0 };

  // No se adelanta una operación de otra API/entorno por sobre la cabeza de la
  // cola. Esto conserva orden incluso si un development build cambió de URL.
  const apiUrl = filas[0]?.api_url;
  const portalOrigin = filas[0]?.portal_origin;
  const lote = filas.filter((fila) =>
    fila.api_url === apiUrl && fila.portal_origin === portalOrigin);
  let operaciones: OperacionSyncNativa[];
  try {
    operaciones = lote.map((fila) => JSON.parse(fila.operation_json) as OperacionSyncNativa);
  } catch {
    throw new Error('cola-operacion-corrupta');
  }

  try {
    const veredictos = await empujar(apiUrl ?? '', portalOrigin ?? '', operaciones);
    const resultados = new Map(veredictos.map((item) => [item.clientId, item]));

    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const fila of lote) {
        const veredicto = resultados.get(fila.client_id);
        if (!veredicto) continue;
        if (veredicto.status === 'rechazado') {
          await txn.runAsync(
            `UPDATE sync_queue SET state = 'rechazada', attempts = attempts + 1,
             rejection_reason = ? WHERE client_id = ?`,
            veredicto.reason ?? 'rechazada-sin-motivo',
            fila.client_id,
          );
        } else {
          await txn.runAsync('DELETE FROM sync_queue WHERE client_id = ?', fila.client_id);
        }
      }
    });
    return { procesadas: resultados.size, pendientes: lote.length - resultados.size };
  } catch (error) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const fila of lote) {
        await txn.runAsync(
          `UPDATE sync_queue SET attempts = attempts + 1, next_attempt_at = ?
           WHERE client_id = ? AND state = 'pendiente'`,
          proximoIntento(fila.attempts + 1),
          fila.client_id,
        );
      }
    });
    throw error;
  }
}

export async function borrarColaSync(): Promise<void> {
  const db = await abrirBaseOperativa();
  await db.runAsync('DELETE FROM sync_queue');
}
