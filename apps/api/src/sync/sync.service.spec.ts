import { PayloadTooLargeException } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { GuardService } from '../guard/guard.service';
import type { RulesService } from '../rules/rules.service';
import type { SyncOperationDto } from './dto/push-batch.dto';
import { SyncService } from './sync.service';

const PATROL = '44444444-4444-4444-8444-444444444444';
const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
const OP3 = '33333333-3333-4333-8333-333333333333';

/** Reglas del producto + el limite de lote del tenant (#14). */
const reglas = (syncMaxBatchSize: number) =>
  ({
    effective: jest
      .fn()
      .mockResolvedValue({ ...patrolRulesSchema.parse({}), syncMaxBatchSize }),
  }) as unknown as RulesService;

interface Bitacora {
  client_id: string;
  status: string;
  reason: string | null;
  server_id: string | null;
}

/**
 * manager.query mockeado. Aca no se usa la cadena estricta de
 * mockResolvedValueOnce porque cada operacion intercala SAVEPOINT / RELEASE /
 * ROLLBACK TO y la cadena pasaria a ser una cuenta de 19 llamadas ilegible: se
 * responde por consulta, que es lo que los tests realmente afirman.
 */
function consultas(escenario: { bitacora?: Bitacora[]; scanId?: string } = {}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (sql.includes('SELECT client_id')) return escenario.bitacora ?? [];
    if (sql.includes('FROM scans')) return [{ id: escenario.scanId ?? 'scan-servidor' }];
    // SAVEPOINT, RELEASE, ROLLBACK TO, el INSERT ... DO NOTHING y el UPDATE de
    // reintentos no devuelven filas.
    return [];
  });
}

interface GuardiaMock {
  registerScan: jest.Mock;
  reportEvent: jest.Mock;
}

function servicio(query: jest.Mock, guard: Partial<GuardiaMock> = {}, maxLote = 200) {
  return new SyncService(
    { manager: { query } } as unknown as TenantContextService,
    guard as unknown as GuardService,
    reglas(maxLote),
  );
}

const guardiaQueEscanea = () => ({
  registerScan: jest.fn().mockResolvedValue({ replay: false, anomalies: [] }),
  reportEvent: jest.fn().mockResolvedValue({ id: 'evento-servidor', replay: false }),
});

const escaneo = (clientId: string, payload: Record<string, unknown>): SyncOperationDto => ({
  type: 'scan',
  clientId,
  patrolId: PATROL,
  payload,
  queuedAt: '2026-08-03T02:10:00.000Z',
});

const ESCANEO_VALIDO = { uid: '04A1B2C3D4', method: 'nfc' };

describe('SyncService — sincronizacion en lote (#14)', () => {
  it('una operacion invalida NO tumba el lote: el resto se aplica', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();
    const lote = {
      operations: [
        escaneo(OP1, ESCANEO_VALIDO),
        escaneo(OP2, { method: 'nfc' }), // sin uid: payload invalido
        escaneo(OP3, ESCANEO_VALIDO),
      ],
    };

    const respuesta = await servicio(query, guard).pushBatch('guard-id', lote);

    expect(respuesta.summary).toEqual({ aplicado: 2, duplicado: 0, rechazado: 1 });
    expect(respuesta.results.map((r) => r.status)).toEqual([
      'aplicado',
      'rechazado',
      'aplicado',
    ]);
    expect(respuesta.results[1]?.reason).toContain('uid');
    // Los 39 escaneos buenos entraron de verdad, no solo en la respuesta.
    expect(guard.registerScan).toHaveBeenCalledTimes(2);
    expect(guard.registerScan).toHaveBeenCalledWith(
      PATROL,
      'guard-id',
      expect.objectContaining({ uid: '04A1B2C3D4', clientScanId: OP1 }),
    );
  });

  it('aisla la operacion invalida con savepoint: sin eso la transaccion muere entera', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, { method: 'nfc' }), escaneo(OP2, ESCANEO_VALIDO)],
    });

    const sentencias = query.mock.calls.map(([sql]: [string]) => sql);
    expect(sentencias).toContain('ROLLBACK TO SAVEPOINT sync_op');
    // El rechazo queda registrado DESPUES del rollback; adentro se habria ido
    // con el, y el supervisor nunca sabria que esa operacion existio.
    const registroRechazo = query.mock.calls.find(
      ([sql, params]: [string, unknown[]]) =>
        sql.includes('INSERT INTO sync_operations') && params[3] === 'rechazado',
    );
    expect(registroRechazo).toBeDefined();
    expect(registroRechazo?.[1][4]).toContain('uid');
  });

  it('el reenvio del mismo lote devuelve todo duplicado y no reprocesa nada', async () => {
    const query = consultas({
      bitacora: [
        { client_id: OP1, status: 'aplicado', reason: null, server_id: 'scan-1' },
        { client_id: OP2, status: 'aplicado', reason: null, server_id: 'scan-2' },
      ],
    });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO), escaneo(OP2, ESCANEO_VALIDO)],
    });

    expect(respuesta.summary).toEqual({ aplicado: 0, duplicado: 2, rechazado: 0 });
    expect(respuesta.results.map((r) => r.serverId)).toEqual(['scan-1', 'scan-2']);
    expect(guard.registerScan).not.toHaveBeenCalled();
    // El reintento se cuenta, pero synced_at_server NO se toca: es la marca de
    // la primera llegada y sostiene la metrica de tiempo sin señal.
    const reintento = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('attempts = attempts + 1'),
    );
    expect(reintento).toBeDefined();
    expect(reintento?.[0]).not.toContain('synced_at_server =');
  });

  it('reenviar la misma cola tres veces conserva exactamente un registro lógico', async () => {
    const query = consultas({
      bitacora: [
        { client_id: OP1, status: 'aplicado', reason: null, server_id: 'scan-1' },
      ],
    });
    const guard = guardiaQueEscanea();
    const sync = servicio(query, guard);
    const lote = { operations: [escaneo(OP1, ESCANEO_VALIDO)] };

    const respuestas = [];
    for (let intento = 0; intento < 3; intento += 1) {
      respuestas.push(await sync.pushBatch('guard-id', lote));
    }

    expect(respuestas.map((r) => r.summary)).toEqual([
      { aplicado: 0, duplicado: 1, rechazado: 0 },
      { aplicado: 0, duplicado: 1, rechazado: 0 },
      { aplicado: 0, duplicado: 1, rechazado: 0 },
    ]);
    expect(guard.registerScan).not.toHaveBeenCalled();
  });

  it('un client_id repetido dentro del mismo lote se aplica una sola vez', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO), escaneo(OP1, ESCANEO_VALIDO)],
    });

    expect(respuesta.results.map((r) => r.status)).toEqual(['aplicado', 'duplicado']);
    expect(guard.registerScan).toHaveBeenCalledTimes(1);
  });

  it('lo ya rechazado se sigue respondiendo rechazado, nunca duplicado', async () => {
    const query = consultas({
      bitacora: [
        {
          client_id: OP1,
          status: 'rechazado',
          reason: 'La ronda ya está cerrada',
          server_id: null,
        },
      ],
    });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO)],
    });

    // Contestar 'duplicado' haria que el dispositivo borrara de su cola algo
    // que jamas se guardo.
    expect(respuesta.results[0]).toEqual({
      clientId: OP1,
      status: 'rechazado',
      reason: 'La ronda ya está cerrada',
    });
    expect(guard.registerScan).not.toHaveBeenCalled();
  });

  it('el lote sobredimensionado se rechaza con 413 y sin tocar la base', async () => {
    const query = consultas();
    const lote = {
      operations: [
        escaneo(OP1, ESCANEO_VALIDO),
        escaneo(OP2, ESCANEO_VALIDO),
        escaneo(OP3, ESCANEO_VALIDO),
      ],
    };

    const push = servicio(query, guardiaQueEscanea(), 2).pushBatch('guard-id', lote);

    await expect(push).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(push).rejects.toThrow('el maximo configurado para tu empresa es 2');
    expect(query).not.toHaveBeenCalled();
  });

  it('el escaneo sin patrolId se rechaza con motivo, no con un 500', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [
        { type: 'scan', clientId: OP1, payload: ESCANEO_VALIDO, queuedAt: '2026-08-03T02:10:00.000Z' },
      ],
    });

    expect(respuesta.results[0]).toMatchObject({
      status: 'rechazado',
      reason: 'Una operacion de tipo scan necesita patrolId',
    });
    expect(guard.registerScan).not.toHaveBeenCalled();
  });

  it('rechaza la operacion cuya clave de idempotencia no coincide con su payload', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [
        escaneo(OP1, { ...ESCANEO_VALIDO, clientScanId: OP2 }),
        escaneo(OP3, ESCANEO_VALIDO),
      ],
    });

    expect(respuesta.results[0]?.status).toBe('rechazado');
    expect(respuesta.results[0]?.reason).toContain('no coincide');
    expect(respuesta.results[1]?.status).toBe('aplicado');
  });

  it('un evento reusa reportEvent y devuelve el id del servidor', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [
        {
          type: 'event',
          clientId: OP1,
          patrolId: PATROL,
          payload: { criticality: 'alta', text: 'Porton forzado en el subterraneo' },
          queuedAt: '2026-08-03T02:40:00.000Z',
        },
      ],
    });

    expect(respuesta.results[0]).toEqual({
      clientId: OP1,
      status: 'aplicado',
      serverId: 'evento-servidor',
    });
    expect(guard.reportEvent).toHaveBeenCalledWith(
      'guard-id',
      expect.objectContaining({ criticality: 'alta', clientEventId: OP1, patrolId: PATROL }),
    );
  });

  it('un escaneo que ya estaba en el servidor vuelve como duplicado, no como error', async () => {
    const query = consultas({ scanId: 'scan-9' });
    const guard = {
      registerScan: jest.fn().mockResolvedValue({ replay: true, anomalies: [] }),
      reportEvent: jest.fn(),
    };

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO)],
    });

    expect(respuesta.results[0]).toEqual({
      clientId: OP1,
      status: 'duplicado',
      serverId: 'scan-9',
    });
  });
});

describe('SyncService — observabilidad de la sincronizacion (#14)', () => {
  it('reporta la ventana de 24h, la ultima sincronizacion y el tiempo sin señal', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        aplicadas: 38,
        duplicadas: 2,
        rechazadas: 1,
        reenvios: 3,
        gap_max_s: 2_640,
        gap_prom_s: 900,
        ultima_sync: new Date('2026-08-03T03:00:00.000Z'),
      },
    ]);

    await expect(servicio(query).syncStatus('guard-id')).resolves.toEqual({
      guardId: 'guard-id',
      windowHours: 24,
      operations: { applied: 38, duplicated: 2, rejected: 1, retransmissions: 3 },
      lastSyncedAt: new Date('2026-08-03T03:00:00.000Z'),
      // 44 minutos sin señal: eso es lo que el supervisor necesita saber del
      // subterraneo, y por eso las dos marcas de tiempo van separadas.
      offlineGapSeconds: { max: 2_640, avg: 900 },
    });
    expect(query.mock.calls[0]?.[0]).toContain('synced_at_server - queued_at_device');
    expect(query.mock.calls[0]?.[1]).toEqual(['guard-id']);
  });

  it('un guardia sin sincronizaciones no rompe: devuelve ceros y sin marca', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      {
        aplicadas: 0,
        duplicadas: 0,
        rechazadas: 0,
        reenvios: 0,
        gap_max_s: null,
        gap_prom_s: null,
        ultima_sync: null,
      },
    ]);

    await expect(servicio(query).syncStatus('guard-id')).resolves.toMatchObject({
      operations: { applied: 0, duplicated: 0, rejected: 0, retransmissions: 0 },
      lastSyncedAt: null,
      offlineGapSeconds: { max: null, avg: null },
    });
  });
});
