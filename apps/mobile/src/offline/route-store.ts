import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { RutaOfflinePayload } from '../bridge/protocol';

const DATABASE_NAME = 'sentrycore-operacion.db';
const KEY_NAME = 'sentrycore.sqlcipher.key.v1';

export interface RutaOfflineGuardada extends RutaOfflinePayload {
  readonly savedAt: string;
}

function aHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function clave(): Promise<string> {
  const existente = await SecureStore.getItemAsync(KEY_NAME);
  if (existente && /^[0-9a-f]{64}$/.test(existente)) return existente;
  const nueva = aHex(await getRandomBytesAsync(32));
  await SecureStore.setItemAsync(KEY_NAME, nueva, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return nueva;
}

let apertura: Promise<SQLiteDatabase> | undefined;

export async function abrirBaseOperativa(): Promise<SQLiteDatabase> {
  return (apertura ??= (async () => {
    const db = await openDatabaseAsync(DATABASE_NAME);
    const key = await clave();
    // Debe ser la primera operación: leer el esquema antes de PRAGMA key hace
    // que SQLCipher interprete páginas cifradas como una base corrupta.
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('sqlcipher-no-disponible');
    await db.execAsync(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS active_route (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        patrol_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pendiente', 'en_curso')),
        scheduled_end_at TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL UNIQUE,
        api_url TEXT NOT NULL,
        portal_origin TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pendiente'
          CHECK (state IN ('pendiente', 'rechazada')),
        rejection_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_queue_pending_order
        ON sync_queue (state, next_attempt_at, queued_at, sequence);
    `);
    return db;
  })());
}

export async function guardarRutaOffline(ruta: RutaOfflinePayload): Promise<string> {
  const db = await abrirBaseOperativa();
  const savedAt = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO active_route (
       singleton, patrol_id, status, scheduled_end_at, saved_at, payload_json
     ) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       patrol_id = excluded.patrol_id,
       status = excluded.status,
       scheduled_end_at = excluded.scheduled_end_at,
       saved_at = excluded.saved_at,
       payload_json = excluded.payload_json`,
    ruta.patrolId,
    ruta.status,
    ruta.scheduledEndAt,
    savedAt,
    JSON.stringify(ruta),
  );
  return savedAt;
}

export async function leerRutaOffline(ahora: Date = new Date()): Promise<RutaOfflineGuardada | undefined> {
  const db = await abrirBaseOperativa();
  const fila = await db.getFirstAsync<{
    payload_json: string;
    saved_at: string;
    scheduled_end_at: string;
  }>('SELECT payload_json, saved_at, scheduled_end_at FROM active_route WHERE singleton = 1');
  if (!fila) return undefined;
  // No mostrar una asignación vieja a la mañana siguiente. Se conserva una
  // gracia de 12 h para rondas nocturnas que terminan después de lo previsto.
  if (Date.parse(fila.scheduled_end_at) + 12 * 60 * 60 * 1_000 < ahora.getTime()) {
    await db.runAsync('DELETE FROM active_route WHERE singleton = 1');
    return undefined;
  }
  try {
    return { ...(JSON.parse(fila.payload_json) as RutaOfflinePayload), savedAt: fila.saved_at };
  } catch {
    await db.runAsync('DELETE FROM active_route WHERE singleton = 1');
    return undefined;
  }
}

export async function borrarRutaOffline(): Promise<void> {
  const db = await abrirBaseOperativa();
  await db.runAsync('DELETE FROM active_route WHERE singleton = 1');
}
