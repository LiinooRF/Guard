import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { SyncConflictsService, type DatosDeAtraso } from './sync-conflicts.service';

const GUARDIA = 'g0000000-0000-4000-8000-000000000001';
const RONDA = '44444444-4444-4444-8444-444444444444';
const RECINTO = '55555555-5555-4555-8555-555555555555';
const MARCA = '66666666-6666-4666-8666-666666666666';
const CLIENT_SCAN = '11111111-1111-4111-8111-111111111111';

/**
 * manager.query mockeado con la forma REAL del driver de PostgreSQL:
 *
 *   - SELECT e INSERT ... RETURNING  ->  arreglo plano de filas
 *   - UPDATE y DELETE sin envolver   ->  [filas, cantidad]
 *
 * Un mock que devuelve [{...}] para un UPDATE deja el test verde y la respuesta
 * rota, asi que aca el UPDATE devuelve lo que devuelve de verdad.
 */
function consultas(respuestas: Array<[RegExp, unknown]>): jest.Mock {
  return jest.fn(async (sql: string) => {
    for (const [patron, respuesta] of respuestas) {
      if (patron.test(sql)) return respuesta;
    }
    // Todo UPDATE que no se declare explicitamente responde como el driver.
    return /^\s*UPDATE/i.test(sql) ? [[], 0] : [];
  });
}

function servicio(query: jest.Mock, ensureAssignedSite = jest.fn().mockResolvedValue(undefined)) {
  const supervisor = { ensureAssignedSite } as unknown as SupervisorService;
  return {
    servicio: new SyncConflictsService(
      { manager: { query } } as unknown as TenantContextService,
      supervisor,
    ),
    ensureAssignedSite,
  };
}

const ATRASO: DatosDeAtraso = {
  patrolId: RONDA,
  guardId: GUARDIA,
  clientScanId: CLIENT_SCAN,
  tagUid: '04A1B2C3D4',
  method: 'nfc',
  patrolStatus: 'vencida',
  clasificacion: 'dentro_de_la_ventana',
  minutosDeAtraso: 0,
  graciaMin: 120,
  scannedAtDevice: '2026-08-03T05:40:00.000Z',
  scannedAtEffective: new Date('2026-08-03T05:40:00.000Z'),
  fuenteDelInstante: 'dispositivo',
  clockOffsetMs: null,
  latitude: -33.45,
  longitude: -70.66,
  accuracyM: 12,
};

describe('SyncConflictsService — reloj del dispositivo (#73)', () => {
  it('sin hora de envio no mide ni escribe nada', async () => {
    const query = consultas([]);
    const { servicio: srv } = servicio(query);

    await expect(srv.medirReloj(GUARDIA, undefined, 5, 3)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('mide contra el now() de PostgreSQL y guarda la tolerancia vigente', async () => {
    const query = consultas([
      [
        /INSERT INTO device_clock_readings/,
        [
          {
            device_reported_at: new Date('2026-08-03T08:00:00.000Z'),
            server_received_at: new Date('2026-08-03T10:00:00.000Z'),
          },
        ],
      ],
    ]);
    const { servicio: srv } = servicio(query);

    await expect(
      srv.medirReloj(GUARDIA, '2026-08-03T08:00:00.000Z', 5, 40),
    ).resolves.toEqual({ offsetMs: 7_200_000, toleranciaMs: 300_000, desfasado: true });

    const [, parametros] = query.mock.calls[0] as [string, unknown[]];
    // La tolerancia se guarda en ms y sale de la regla, no de una constante.
    expect(parametros[2]).toBe(300_000);
    expect(parametros[3]).toBe(40);
  });

  it('el guardia sin mediciones previas no rompe la consulta de estado', async () => {
    const query = consultas([
      [
        /FROM device_clock_readings/,
        [
          {
            server_now: new Date('2026-08-03T10:00:00.000Z'),
            device_reported_at: null,
            server_received_at: null,
          },
        ],
      ],
    ]);
    const { servicio: srv } = servicio(query);

    await expect(srv.estadoDelReloj(GUARDIA, 5)).resolves.toEqual({
      serverTime: new Date('2026-08-03T10:00:00.000Z'),
      toleranceMin: 5,
      lastReading: null,
      warning: null,
    });
  });

  it('marca el desfase en el escaneo SIN pisar la hora cruda del telefono', async () => {
    const query = consultas([]);
    const { servicio: srv } = servicio(query);

    await srv.marcarRelojDesfasado(RONDA, CLIENT_SCAN, 7_200_000);

    const [sql, parametros] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE scans');
    expect(sql).toContain('clock_offset_ms = $3');
    // La hora del dispositivo es la evidencia: no se reescribe nunca.
    expect(sql).not.toContain('scanned_at_device =');
    // La anomalia se agrega una sola vez aunque el lote se reenvie.
    expect(sql).toContain("anomalies @> '[\"reloj_desfasado\"]'::jsonb");
    expect(parametros).toEqual([RONDA, CLIENT_SCAN, 7_200_000]);
  });
});

describe('SyncConflictsService — marcas atrasadas (#73)', () => {
  it('guarda la marca atrasada y devuelve su id', async () => {
    const query = consultas([[/INSERT INTO late_scans/, [{ id: MARCA }]]]);
    const { servicio: srv } = servicio(query);

    await expect(srv.registrarAtrasado(ATRASO)).resolves.toBe(MARCA);

    const [sql, parametros] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (tenant_id, patrol_id, client_scan_id) DO NOTHING');
    expect(sql).toContain('app_tenant_id()');
    expect(parametros[0]).toBe(RONDA);
    expect(parametros[3]).toBe('04A1B2C3D4');
  });

  it('el reenvio de la cola no deja dos anexos de la misma marca', async () => {
    // ON CONFLICT DO NOTHING no devuelve fila: es un reenvio, no un error.
    const query = consultas([[/INSERT INTO late_scans/, []]]);
    const { servicio: srv } = servicio(query);

    await expect(srv.registrarAtrasado(ATRASO)).resolves.toBeNull();
  });

  it('devuelve el estado de la ronda con la hora del servidor', async () => {
    const query = consultas([
      [
        /FROM patrols/,
        [
          {
            status: 'vencida',
            closed_at: null,
            scheduled_end_at: new Date('2026-08-03T06:00:00.000Z'),
            site_id: RECINTO,
            server_now: new Date('2026-08-03T09:00:00.000Z'),
          },
        ],
      ],
    ]);
    const { servicio: srv } = servicio(query);

    await expect(srv.rondaDeLaOperacion(RONDA, GUARDIA)).resolves.toEqual({
      status: 'vencida',
      closedAt: null,
      scheduledEndAt: new Date('2026-08-03T06:00:00.000Z'),
      siteId: RECINTO,
      serverNow: new Date('2026-08-03T09:00:00.000Z'),
    });
  });

  it('guarda la marca atrasada con método QR y coordenadas satelitales', async () => {
    const query = consultas([[/INSERT INTO late_scans/, [{ id: 'late-qr-1' }]]]);
    const { servicio: srv } = servicio(query);

    const atrasoQr: DatosDeAtraso = {
      ...ATRASO,
      method: 'qr',
      tagUid: 'VXQ-ZE7OSHLBFVJT3CZ3C4KPAPF2Z4',
      latitude: -33.4372,
      longitude: -70.6506,
      accuracyM: 8,
      clockOffsetMs: 5000,
    };

    await expect(srv.registrarAtrasado(atrasoQr)).resolves.toBe('late-qr-1');

    const [, parametros] = query.mock.calls[0] as [string, unknown[]];
    expect(parametros[3]).toBe('VXQ-ZE7OSHLBFVJT3CZ3C4KPAPF2Z4');
    expect(parametros[4]).toBe('qr');
    expect(parametros[12]).toBe(5000);
    expect(parametros[13]).toBe(-33.4372);
    expect(parametros[14]).toBe(-70.6506);
    expect(parametros[15]).toBe(8);
  });

  it('la ronda que no es de este guardia no la decide este modulo', async () => {
    const query = consultas([[/FROM patrols/, []]]);
    const { servicio: srv } = servicio(query);

    // null = "no opino": registerScan contesta su 404 y no se duplica el error.
    await expect(srv.rondaDeLaOperacion(RONDA, GUARDIA)).resolves.toBeNull();
  });
});

describe('SyncConflictsService — bandeja del supervisor (#73)', () => {
  it('un supervisor sin ese recinto asignado no ve nada, ni siquiera consulta', async () => {
    const query = consultas([]);
    const negar = jest.fn().mockRejectedValue(new ForbiddenException('No tienes este recinto asignado'));
    const { servicio: srv } = servicio(query, negar);

    await expect(srv.listarAtrasados(RECINTO, GUARDIA)).rejects.toBeInstanceOf(ForbiddenException);
    // El permiso patrols:monitor NO alcanza: el recinto se verifica aparte.
    expect(query).not.toHaveBeenCalled();
  });

  it('devuelve la zona horaria del recinto y el offset como numero', async () => {
    const query = consultas([
      [
        /FROM late_scans/,
        [
          {
            id: MARCA,
            patrol_id: RONDA,
            guard_id: GUARDIA,
            guard_name: 'Juan Pérez',
            route_name: 'Perímetro norte',
            timezone: 'America/Santiago',
            checkpoint_name: 'Bodega 3',
            tag_uid: '04A1B2C3D4',
            method: 'nfc',
            patrol_status: 'vencida',
            classification: 'dentro_de_la_ventana',
            minutes_late: 0,
            grace_min: 120,
            scanned_at_device: new Date('2026-08-03T05:40:00.000Z'),
            scanned_at_effective: new Date('2026-08-03T07:40:00.000Z'),
            effective_source: 'corregido',
            // bigint llega como string desde el driver de PostgreSQL.
            clock_offset_ms: '7200000',
            received_at_server: new Date('2026-08-03T09:00:00.000Z'),
            reviewed_at: null,
            review_decision: null,
            review_note: null,
          },
        ],
      ],
    ]);
    const { servicio: srv, ensureAssignedSite } = servicio(query);

    const bandeja = await srv.listarAtrasados(RECINTO, GUARDIA);

    expect(ensureAssignedSite).toHaveBeenCalledWith(RECINTO, GUARDIA);
    expect(bandeja[0]).toMatchObject({
      id: MARCA,
      // El panel formatea con la zona del RECINTO, no con la del servidor.
      timezone: 'America/Santiago',
      clockOffsetMs: 7_200_000,
      effectiveSource: 'corregido',
      suggestion: 'justificado',
      pending: true,
    });
    // Lo pendiente va primero: es lo unico sobre lo que se puede hacer algo.
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('ORDER BY (ls.reviewed_at IS NULL) DESC');
    // El uid solo resuelve contra la etiqueta ACTIVA: el indice unico es parcial
    // y sin ese filtro una etiqueta reemplazada duplicaria la fila.
    expect(sql).toContain('LEFT JOIN tags t ON t.uid = ls.tag_uid AND t.is_active');
  });
});

describe('SyncConflictsService — revision de una marca atrasada (#73)', () => {
  const contexto = (fila: unknown[]) => [/FROM late_scans ls\s+JOIN patrols/, fila] as [RegExp, unknown];

  it('una marca que no existe da 404 y no toca el recinto', async () => {
    const query = consultas([contexto([])]);
    const { servicio: srv, ensureAssignedSite } = servicio(query);

    await expect(
      srv.revisar(MARCA, GUARDIA, 'justificado', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ensureAssignedSite).not.toHaveBeenCalled();
  });

  it('revisar una marca de un recinto ajeno queda cerrado', async () => {
    const query = consultas([contexto([{ site_id: RECINTO, reviewed_at: null }])]);
    const negar = jest.fn().mockRejectedValue(new ForbiddenException('No tienes este recinto asignado'));
    const { servicio: srv } = servicio(query, negar);

    await expect(
      srv.revisar(MARCA, GUARDIA, 'justificado', undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Solo alcanzo a leer el contexto; no escribio la revision.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lo ya revisado no se vuelve a revisar', async () => {
    const query = consultas([
      contexto([{ site_id: RECINTO, reviewed_at: new Date('2026-08-03T12:00:00.000Z') }]),
    ]);
    const { servicio: srv } = servicio(query);

    await expect(
      srv.revisar(MARCA, GUARDIA, 'justificado', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('deja escrito quien reviso, cuando y que decidio', async () => {
    const query = consultas([
      contexto([{ site_id: RECINTO, reviewed_at: null }]),
      [
        /WITH revisado AS/,
        [
          {
            id: MARCA,
            reviewed_at: new Date('2026-08-03T12:00:00.000Z'),
            review_decision: 'justificado',
          },
        ],
      ],
    ]);
    const { servicio: srv } = servicio(query);

    await expect(
      srv.revisar(MARCA, GUARDIA, 'justificado', 'El guardia marcó a tiempo, sin señal'),
    ).resolves.toEqual({
      id: MARCA,
      reviewedAt: new Date('2026-08-03T12:00:00.000Z'),
      reviewDecision: 'justificado',
    });

    const [sql, parametros] = query.mock.calls[1] as [string, unknown[]];
    // El UPDATE va envuelto en CTE: suelto, el driver devolveria [filas,
    // cantidad] y revisada[0] seria el arreglo de filas, no una fila.
    expect(sql).toContain('WITH revisado AS');
    expect(sql).toContain('SELECT id, reviewed_at, review_decision FROM revisado');
    expect(parametros).toEqual([
      MARCA,
      GUARDIA,
      'justificado',
      'El guardia marcó a tiempo, sin señal',
    ]);
  });

  it('si otro supervisor la reviso en el intertanto, no se pisa su revision', async () => {
    const query = consultas([
      contexto([{ site_id: RECINTO, reviewed_at: null }]),
      [/WITH revisado AS/, []],
    ]);
    const { servicio: srv } = servicio(query);

    await expect(
      srv.revisar(MARCA, GUARDIA, 'no_justificado', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
