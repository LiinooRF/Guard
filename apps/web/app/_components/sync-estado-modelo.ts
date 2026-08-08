/**
 * El modelo puro del estado de sincronización, separado del componente para
 * poder probarlo: `sync-estado.tsx` trae JSX y no entra al runner.
 */

/** Lo que el servidor dice que tiene. `null` = no se pudo preguntar. */
export interface EstadoServidor {
  confirmadas: number;
  rechazadas: number;
  windowHours?: number;
  lastSyncedAt?: string;
}

/** La forma del `GET /sync/status` que el portal entiende. */
export interface CuerpoSyncStatus {
  windowHours?: number;
  operations?: { applied?: number; duplicated?: number; rejected?: number };
  records?: { total?: number; lastReceivedAt?: string | null };
  lastSyncedAt?: string | null;
}

/**
 * Del cuerpo de la API a lo que la pantalla afirma. Lo que sale de aquí termina
 * en una FRASE que el guardia lee como verdad ("Tiene N registros tuyos…"), y
 * esa frase ya mintió una vez: contaba solo operaciones de la cola offline, y
 * con dos escaneos directos aceptados en la base decía "el servidor todavía no
 * tiene registros tuyos" — al lado de "Todo subido".
 *
 * `records` cuenta los registros de verdad (escaneos y novedades, por cola o
 * directos). Si la API es vieja y no lo manda, se cae al conteo de la cola —
 * impreciso, pero nunca inventa.
 */
export function resumirEstadoServidor(cuerpo: CuerpoSyncStatus): EstadoServidor {
  // 'aplicado' y 'duplicado' son el mismo desenlace para el guardia: el
  // trabajo esta en el servidor. La distincion es de observabilidad.
  const aplicadas = cuerpo.operations?.applied ?? 0;
  const duplicadas = cuerpo.operations?.duplicated ?? 0;
  const confirmadas = cuerpo.records?.total ?? aplicadas + duplicadas;
  const ultimo = cuerpo.records?.lastReceivedAt ?? cuerpo.lastSyncedAt;
  return {
    confirmadas,
    rechazadas: cuerpo.operations?.rejected ?? 0,
    ...(typeof cuerpo.windowHours === 'number' ? { windowHours: cuerpo.windowHours } : {}),
    ...(typeof ultimo === 'string' ? { lastSyncedAt: ultimo } : {}),
  };
}
