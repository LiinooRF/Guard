import { PayloadTooLargeException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { GuardService } from '../guard/guard.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import type { SyncOperationDto } from './dto/push-batch.dto';
import { SyncConflictsService } from './sync-conflicts.service';
import { SyncService } from './sync.service';

const PATROL = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
const OP3 = '33333333-3333-4333-8333-333333333333';

/**
 * Reglas del producto + el limite de lote del tenant (#14) + los dos parametros
 * de #73. Se fijan explicitos para que el test no dependa de que default tenga
 * rules.ts hoy.
 */
const reglas = (syncMaxBatchSize: number) =>
  ({
    effective: jest.fn().mockResolvedValue({
      ...patrolRulesSchema.parse({}),
      syncMaxBatchSize,
      clockSkewToleranceMin: 5,
      lateScanGraceMin: 120,
    }),
  }) as unknown as RulesService;

interface Bitacora {
  client_id: string;
  status: string;
  reason: string | null;
  server_id: string | null;
}

interface RondaMock {
  status: string;
  closed_at: Date | null;
  scheduled_end_at: Date;
  site_id: string;
  server_now: Date;
}

interface Escenario {
  bitacora?: Bitacora[];
  scanId?: string;
  ronda?: RondaMock;
  /** Marcas de tiempo que devuelve el INSERT de la medicion de reloj. */
  reloj?: { device: string; server: string };
}

/**
 * manager.query mockeado. Aca no se usa la cadena estricta de
 * mockResolvedValueOnce porque cada operacion intercala SAVEPOINT / RELEASE /
 * ROLLBACK TO y la cadena pasaria a ser una cuenta de 19 llamadas ilegible: se
 * responde por consulta, que es lo que los tests realmente afirman.
 *
 * Las formas son las del driver de PostgreSQL: SELECT e INSERT ... RETURNING
 * devuelven filas planas; UPDATE devuelve [filas, cantidad].
 */
function consultas(escenario: Escenario = {}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (sql.includes('SELECT client_id')) return escenario.bitacora ?? [];
    if (sql.includes('INSERT INTO device_clock_readings')) {
      return escenario.reloj
        ? [
            {
              device_reported_at: new Date(escenario.reloj.device),
              server_received_at: new Date(escenario.reloj.server),
            },
          ]
        : [];
    }
    if (sql.includes('FROM patrols')) return escenario.ronda ? [escenario.ronda] : [];
    if (sql.includes('INSERT INTO late_scans')) return [{ id: 'marca-atrasada-1' }];
    if (sql.includes('FROM scans')) return [{ id: escenario.scanId ?? 'scan-servidor' }];
    // SAVEPOINT, RELEASE, ROLLBACK TO y el INSERT ... DO NOTHING no devuelven filas.
    return /^\s*UPDATE/i.test(sql) ? [[], 0] : [];
  });
}

interface GuardiaMock {
  registerScan: jest.Mock;
  reportEvent: jest.Mock;
}

function servicio(query: jest.Mock, guard: Partial<GuardiaMock> = {}, maxLote = 200) {
  const tenantContext = { manager: { query } } as unknown as TenantContextService;
  const supervisor = {
    ensureAssignedSite: jest.fn().mockResolvedValue(undefined),
  } as unknown as SupervisorService;
  return new SyncService(
    tenantContext,
    guard as unknown as GuardService,
    reglas(maxLote),
    new SyncConflictsService(tenantContext, supervisor),
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

/** Indice de la primera consulta que contiene el texto. -1 si no aparece. */
const indiceDe = (query: jest.Mock, texto: string) =>
  query.mock.calls.findIndex(([sql]: [string]) => sql.includes(texto));

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
    const query = jest.fn()
      .mockResolvedValueOnce([
        {
          aplicadas: 38,
          duplicadas: 2,
          rechazadas: 1,
          reenvios: 3,
          gap_max_s: 2_640,
          gap_prom_s: 900,
          ultima_sync: new Date('2026-08-03T03:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        { escaneos: 41, eventos: 2, ultimo: new Date('2026-08-03T03:05:00.000Z') },
      ]);

    await expect(servicio(query).syncStatus('guard-id')).resolves.toEqual({
      guardId: 'guard-id',
      windowHours: 24,
      operations: { applied: 38, duplicated: 2, rejected: 1, retransmissions: 3 },
      records: {
        scans: 41,
        events: 2,
        total: 43,
        lastReceivedAt: new Date('2026-08-03T03:05:00.000Z'),
      },
      lastSyncedAt: new Date('2026-08-03T03:00:00.000Z'),
      // 44 minutos sin señal: eso es lo que el supervisor necesita saber del
      // subterraneo, y por eso las dos marcas de tiempo van separadas.
      offlineGapSeconds: { max: 2_640, avg: 900 },
    });
    expect(query.mock.calls[0]?.[0]).toContain('synced_at_server - queued_at_device');
    expect(query.mock.calls[0]?.[1]).toEqual(['guard-id']);
  });

  it('cuenta los REGISTROS reales del guardia, no solo las operaciones de la cola', async () => {
    /*
     * El caso real: dos escaneos directos aceptados en la base, cola vacia, y
     * el panel decia "El servidor todavia no tiene registros tuyos". Confundio
     * al guardia en terreno y desvio un diagnostico entero. Un contador que
     * dice "registros" cuenta registros — vengan por la cola o directos.
     */
    const query = jest.fn()
      .mockResolvedValueOnce([
        {
          aplicadas: 0, duplicadas: 0, rechazadas: 0, reenvios: 0,
          gap_max_s: null, gap_prom_s: null, ultima_sync: null,
        },
      ])
      .mockResolvedValueOnce([
        { escaneos: 2, eventos: 0, ultimo: new Date('2026-08-08T15:55:13.000Z') },
      ]);

    await expect(servicio(query).syncStatus('guard-id')).resolves.toMatchObject({
      operations: { applied: 0 },
      records: { total: 2, lastReceivedAt: new Date('2026-08-08T15:55:13.000Z') },
    });
    // La consulta de registros mira las tablas de verdad, no la cola.
    expect(query.mock.calls[1]?.[0]).toContain('FROM scans');
    expect(query.mock.calls[1]?.[0]).toContain('FROM field_events');
  });

  it('un guardia sin sincronizaciones no rompe: devuelve ceros y sin marca', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        {
          aplicadas: 0,
          duplicadas: 0,
          rechazadas: 0,
          reenvios: 0,
          gap_max_s: null,
          gap_prom_s: null,
          ultima_sync: null,
        },
      ])
      .mockResolvedValueOnce([{ escaneos: 0, eventos: 0, ultimo: null }]);

    await expect(servicio(query).syncStatus('guard-id')).resolves.toMatchObject({
      operations: { applied: 0, duplicated: 0, rejected: 0, retransmissions: 0 },
      records: { scans: 0, events: 0, total: 0, lastReceivedAt: null },
      lastSyncedAt: null,
      offlineGapSeconds: { max: null, avg: null },
    });
  });
});

describe('SyncService — reloj del dispositivo (#73)', () => {
  it('EL BUG: una ronda entera sin señal no queda marcada como reloj desfasado', async () => {
    // Escaneos encolados a las 02:10 y enviados a las 05:10, con el reloj del
    // telefono correcto. Antes esto marcaba 3 horas de desfase en cada escaneo.
    const query = consultas({
      reloj: { device: '2026-08-03T05:10:00.000Z', server: '2026-08-03T05:10:01.000Z' },
    });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      deviceTime: '2026-08-03T05:10:00.000Z',
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T02:10:00.000Z' })],
    });

    expect(respuesta.clock).toEqual({
      offsetMs: 1_000,
      toleranceMs: 300_000,
      skewed: false,
    });
    expect(respuesta.results[0]?.status).toBe('aplicado');
    // Reloj sano: no se anota correccion en el escaneo.
    expect(indiceDe(query, 'UPDATE scans')).toBe(-1);
  });

  it('el reloj desfasado se MARCA en el escaneo y no lo descarta', async () => {
    const query = consultas({
      reloj: { device: '2026-08-03T08:00:00.000Z', server: '2026-08-03T10:00:00.000Z' },
    });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      deviceTime: '2026-08-03T08:00:00.000Z',
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T07:30:00.000Z' })],
    });

    // El escaneo ENTRA igual: descartarlo castigaria al guardia por la
    // configuracion de su telefono.
    expect(respuesta.results[0]?.status).toBe('aplicado');
    expect(guard.registerScan).toHaveBeenCalledTimes(1);
    expect(respuesta.clock).toEqual({
      offsetMs: 7_200_000,
      toleranceMs: 300_000,
      skewed: true,
    });

    const marca = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE scans'));
    expect(marca).toBeDefined();
    expect(marca?.[1]).toEqual([PATROL, OP1, 7_200_000]);
  });

  it('una app antigua que no manda su hora sincroniza igual, solo que sin medicion', async () => {
    const query = consultas();
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO)],
    });

    expect(respuesta.clock).toBeNull();
    expect(respuesta.results[0]?.status).toBe('aplicado');
    expect(indiceDe(query, 'INSERT INTO device_clock_readings')).toBe(-1);
  });

  it('expone la hora del servidor y la ultima medicion para revisar antes de la ronda', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        server_now: new Date('2026-08-03T10:00:00.000Z'),
        device_reported_at: new Date('2026-08-03T08:00:00.000Z'),
        server_received_at: new Date('2026-08-03T10:00:00.000Z'),
      },
    ]);

    const estado = await servicio(query).clockStatus('guard-id');

    expect(estado.serverTime).toEqual(new Date('2026-08-03T10:00:00.000Z'));
    expect(estado.lastReading).toMatchObject({ offsetMin: 120, skewed: true });
    expect(estado.warning).toContain('atrasado');
    // Consultar la hora no puede ensuciar la bitacora de mediciones.
    expect(indiceDe(query, 'INSERT INTO device_clock_readings')).toBe(-1);
  });
});

describe('SyncService — marcas atrasadas sobre una ronda cerrada (#73)', () => {
  const rondaVencida = (): RondaMock => ({
    status: 'vencida',
    closed_at: null,
    scheduled_end_at: new Date('2026-08-03T06:00:00.000Z'),
    site_id: SITE,
    server_now: new Date('2026-08-03T09:00:00.000Z'),
  });

  it('la marca hecha a tiempo que llega tarde NO se pierde', async () => {
    const query = consultas({ ronda: rondaVencida() });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T05:40:00.000Z' })],
    });

    // La ronda cerrada gana: no se reabre ni se recalcula su cumplimiento.
    expect(guard.registerScan).not.toHaveBeenCalled();
    expect(respuesta.results[0]?.status).toBe('rechazado');
    // Pero el escaneo quedo guardado, y el guardia lo sabe.
    expect(respuesta.results[0]?.lateScanId).toBe('marca-atrasada-1');
    expect(respuesta.results[0]?.reason).toContain('llegó tarde por falta de señal');
    expect(respuesta.results[0]?.reason).toContain('no se perdió');

    const [, parametros] = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO late_scans'),
    ) as [string, unknown[]];
    expect(parametros[6]).toBe('dentro_de_la_ventana');
    expect(parametros[7]).toBe(0);
    // El plazo de gracia vigente queda escrito con la marca.
    expect(parametros[8]).toBe(120);
  });

  it('la marca atrasada se guarda DESPUES del rollback, o se iria con el', async () => {
    const query = consultas({ ronda: rondaVencida() });

    await servicio(query, guardiaQueEscanea()).pushBatch('guard-id', {
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T05:40:00.000Z' })],
    });

    const rollback = indiceDe(query, 'ROLLBACK TO SAVEPOINT sync_op');
    const anexo = indiceDe(query, 'INSERT INTO late_scans');
    const bitacora = indiceDe(query, 'INSERT INTO sync_operations');

    expect(rollback).toBeGreaterThan(-1);
    expect(anexo).toBeGreaterThan(rollback);
    expect(bitacora).toBeGreaterThan(anexo);
  });

  it('la marca muy posterior al cierre queda fuera de plazo y a la vista del supervisor', async () => {
    const query = consultas({ ronda: rondaVencida() });

    const respuesta = await servicio(query, guardiaQueEscanea()).pushBatch('guard-id', {
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T08:30:00.000Z' })],
    });

    expect(respuesta.results[0]?.reason).toContain('fuera del plazo de 120 min');
    const [, parametros] = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO late_scans'),
    ) as [string, unknown[]];
    expect(parametros[6]).toBe('fuera_de_plazo');
    expect(parametros[7]).toBe(150);
  });

  it('con el reloj desfasado, la hora que decide es la CORREGIDA', async () => {
    // El telefono va 2 horas atrasado. Marca "05:40" que en realidad fue 07:40:
    // una hora y 40 minutos DESPUES del cierre. Con la hora cruda habria pasado
    // por marca hecha a tiempo, que es justo lo que se busca evitar.
    const query = consultas({
      ronda: rondaVencida(),
      reloj: { device: '2026-08-03T07:00:00.000Z', server: '2026-08-03T09:00:00.000Z' },
    });

    const respuesta = await servicio(query, guardiaQueEscanea()).pushBatch('guard-id', {
      deviceTime: '2026-08-03T07:00:00.000Z',
      operations: [escaneo(OP1, { ...ESCANEO_VALIDO, scannedAt: '2026-08-03T05:40:00.000Z' })],
    });

    const [, parametros] = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO late_scans'),
    ) as [string, unknown[]];
    expect(parametros[6]).toBe('dentro_de_gracia');
    expect(parametros[7]).toBe(100);
    // Se guardan las dos horas: la cruda es la evidencia, la corregida es la
    // que se uso para decidir.
    expect(parametros[9]).toBe('2026-08-03T05:40:00.000Z');
    expect(parametros[10]).toEqual(new Date('2026-08-03T07:40:00.000Z'));
    expect(parametros[11]).toBe('corregido');
    expect(respuesta.results[0]?.status).toBe('rechazado');
  });

  it('la ronda abierta sigue su curso normal, sin pasar por marcas atrasadas', async () => {
    const query = consultas({
      ronda: {
        status: 'en_curso',
        closed_at: null,
        scheduled_end_at: new Date('2026-08-03T06:00:00.000Z'),
        site_id: SITE,
        server_now: new Date('2026-08-03T05:00:00.000Z'),
      },
    });
    const guard = guardiaQueEscanea();

    const respuesta = await servicio(query, guard).pushBatch('guard-id', {
      operations: [escaneo(OP1, ESCANEO_VALIDO)],
    });

    expect(respuesta.results[0]?.status).toBe('aplicado');
    expect(guard.registerScan).toHaveBeenCalledTimes(1);
    expect(indiceDe(query, 'INSERT INTO late_scans')).toBe(-1);
  });
});
