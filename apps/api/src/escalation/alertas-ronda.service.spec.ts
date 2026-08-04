import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EventsStreamService } from '../events-stream/events-stream.service';
import type { PushService } from '../push/push.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { AlertasRondaService } from './alertas-ronda.service';

/**
 * Los cuatro parametros de alertas se agregan a patrolRulesSchema (ver
 * INTEGRACION.md). Se mezclan aca para que el test describa el contrato que el
 * servicio consume, igual que hace escalation.service.spec.ts.
 */
const REGLAS = {
  ...patrolRulesSchema.parse({}),
  complianceThreshold: 70,
  maxPatrolDurationMin: 480,
  escalationCriticalities: ['alta', 'panico'],
  patrolStartGraceMin: 10,
  patrolLateGraceMin: 15,
  alertAnomalyScanThreshold: 3,
  alertLookbackDays: 3,
} as unknown as PatrolRules;

function servicio(query: jest.Mock, reglas: PatrolRules = REGLAS) {
  const ensureAssignedSite = jest.fn().mockResolvedValue(undefined);
  const effective = jest.fn().mockResolvedValue(reglas);
  const send = jest.fn().mockResolvedValue({ enqueued: 1 });
  const publish = jest.fn();

  const service = new AlertasRondaService(
    { manager: { query } } as unknown as TenantContextService,
    { effective } as unknown as RulesService,
    { ensureAssignedSite } as unknown as SupervisorService,
    { send } as unknown as PushService,
    { publish } as unknown as EventsStreamService,
  );
  return { service, ensureAssignedSite, effective, send, publish };
}

/** Nada detectado y nada que avisar: el camino corto de evaluarRecinto(). */
function sinDeteccion(query: jest.Mock): jest.Mock {
  return query
    .mockResolvedValueOnce([]) // detectar rondas
    .mockResolvedValueOnce([]) // detectar eventos
    .mockResolvedValueOnce([]); // tomar sin avisar
}

const SQLS = (query: jest.Mock): string[] =>
  query.mock.calls.map(([sql]: [string]) => sql as string);

describe('AlertasRondaService — tablero (#98)', () => {
  it('el recinto no asignado no llega ni a consultar', async () => {
    const query = jest.fn();
    const { service, ensureAssignedSite } = servicio(query);
    ensureAssignedSite.mockRejectedValueOnce(new ForbiddenException('No tienes este recinto asignado'));

    await expect(service.listar('site-1', 'sup-1', true)).rejects.toThrow(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });

  it('devuelve las alertas del recinto con el conteo de pendientes por tipo', async () => {
    const detectada = new Date('2026-08-03T01:10:00.000Z');
    const query = sinDeteccion(jest.fn())
      .mockResolvedValueOnce([
        {
          id: 'al-1',
          kind: 'no_iniciada',
          severity: 'alta',
          detected_at: detectada,
          service_day: '2026-08-02',
          detail: { toleranceMin: 10 },
          patrol_id: 'ronda-1',
          field_event_id: null,
          attended_at: null,
          attended_by: null,
          attended_comment: null,
          attended_by_name: null,
          patrol_status: 'pendiente',
          scheduled_start_at: new Date('2026-08-03T01:00:00.000Z'),
          scheduled_end_at: new Date('2026-08-03T02:00:00.000Z'),
          route_name: 'Perímetro norte',
          guard_name: 'Ana Díaz',
        },
      ])
      .mockResolvedValueOnce([
        { kind: 'no_iniciada', total: '1' },
        { kind: 'incompleta', total: '2' },
      ]);
    const { service } = servicio(query);

    const tablero = await service.listar('site-1', 'sup-1', true);

    expect(tablero.pendingTotal).toBe(3);
    expect(tablero.pendingByKind).toEqual({ no_iniciada: 1, incompleta: 2 });
    expect(tablero.alerts).toHaveLength(1);
    expect(tablero.alerts[0]).toMatchObject({
      id: 'al-1',
      kind: 'no_iniciada',
      title: 'Ronda sin iniciar',
      patrolId: 'ronda-1',
      routeName: 'Perímetro norte',
      attendedAt: null,
    });
  });

  it('onlyPending viaja como parámetro ligado, no concatenado en el SQL', async () => {
    const query = sinDeteccion(jest.fn())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await service.listar('site-1', 'sup-1', false);

    const listado = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM patrol_alerts a'));
    expect(listado[1]).toEqual(['site-1', false]);
  });
});

describe('AlertasRondaService — detección (#98)', () => {
  it('la ronda que no arrancó genera alerta sin esperar el cierre', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'al-1',
          site_id: 'site-1',
          kind: 'no_iniciada',
          severity: 'alta',
          patrol_id: 'ronda-1',
          field_event_id: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // ya no queda nada por avisar
    const { service } = servicio(query);

    await expect(service.evaluarRecinto('site-1')).resolves.toEqual({ detected: 1, notified: 0 });

    const deteccion = query.mock.calls[0];
    expect(deteccion[0]).toContain(`'no_iniciada'`);
    // La condición NO mira el cierre: solo el estado 'pendiente' y la tolerancia.
    expect(deteccion[0]).toContain(`r.status = 'pendiente'`);
  });

  it('los umbrales salen de las reglas, en el orden que espera el SQL', async () => {
    const query = sinDeteccion(jest.fn());
    const { service } = servicio(query);

    await service.evaluarRecinto('site-1');

    expect(query.mock.calls[0][1]).toEqual([
      'site-1',
      3, // alertLookbackDays
      10, // patrolStartGraceMin
      15, // patrolLateGraceMin
      480, // maxPatrolDurationMin
      70, // complianceThreshold
      3, // alertAnomalyScanThreshold
    ]);
    expect(query.mock.calls[1][1]).toEqual(['site-1', ['alta', 'panico'], 3]);
  });

  it('un tenant que subió el umbral a 85 detecta con 85, no con el default', async () => {
    const query = sinDeteccion(jest.fn());
    const { service } = servicio(query, {
      ...REGLAS,
      complianceThreshold: 85,
      maxPatrolDurationMin: 240,
    } as PatrolRules);

    await service.evaluarRecinto('site-1');

    expect(query.mock.calls[0][1][4]).toBe(240);
    expect(query.mock.calls[0][1][5]).toBe(85);
  });

  it('un detector roto no bota el tablero: se registra y se sigue leyendo', async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('column "inventada" does not exist'))
      .mockResolvedValueOnce([]) // listado
      .mockResolvedValueOnce([]); // conteos
    const { service } = servicio(query);

    const tablero = await service.listar('site-1', 'sup-1', true);
    expect(tablero.detectedNow).toBe(0);
    expect(tablero.alerts).toEqual([]);
  });
});

describe('AlertasRondaService — aviso (#98)', () => {
  const tomada = {
    id: 'al-1',
    site_id: 'site-1',
    kind: 'vencida',
    severity: 'alta',
    patrol_id: 'ronda-1',
    field_event_id: null,
    detected_at: new Date('2026-08-03T09:00:00.000Z'),
  };

  it('avisa una sola vez por alerta, a los supervisores asignados', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tomada])
      .mockResolvedValueOnce([{ user_id: 'sup-1' }, { user_id: 'sup-2' }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', name: 'Planta Sur' }]);
    const { service, send, publish } = servicio(query);

    await expect(service.evaluarRecinto('site-1')).resolves.toEqual({ detected: 0, notified: 1 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      ['sup-1', 'sup-2'],
      expect.objectContaining({
        title: 'Ronda vencida',
        urgency: 'alta',
        deepLink: { destino: 'ronda', id: 'ronda-1', siteId: 'site-1' },
      }),
      { idempotencyKey: 'patrol-alert:al-1' },
    );
    expect(publish).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ type: 'alerta_ronda', alertId: 'al-1', siteId: 'site-1' }),
    );
  });

  it('el cuerpo del push no lleva nombres ni el detalle del hecho', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tomada])
      .mockResolvedValueOnce([{ user_id: 'sup-1' }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', name: 'Planta Sur' }]);
    const { service, send } = servicio(query);

    await service.evaluarRecinto('site-1');

    const notificacion = send.mock.calls[0][1] as { body: string };
    expect(notificacion.body).toBe('Planta Sur: revisa el tablero de alertas.');
    expect(notificacion.body).not.toMatch(/Ana|Díaz|ronda-1/);
  });

  it('sin supervisores asignados no inventa destinatarios, pero sí publica en el tablero', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tomada])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tenant_id: 't-1', name: 'Planta Sur' }]);
    const { service, send, publish } = servicio(query);

    await service.evaluarRecinto('site-1');

    expect(send).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('una alerta de incidente grave apunta al evento, no a una ronda', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...tomada,
          id: 'al-9',
          kind: 'incidente_grave',
          patrol_id: null,
          field_event_id: 'ev-1',
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'sup-1' }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', name: 'Planta Sur' }]);
    const { service, send } = servicio(query);

    await service.evaluarRecinto('site-1');

    expect(send).toHaveBeenCalledWith(
      ['sup-1'],
      expect.objectContaining({
        deepLink: { destino: 'evento', id: 'ev-1', siteId: 'site-1' },
      }),
      { idempotencyKey: 'patrol-alert:al-9' },
    );
  });
});

describe('AlertasRondaService — acuse con comentario (#98)', () => {
  it('queda registro de quién atendió y qué hizo', async () => {
    const attendedAt = new Date('2026-08-03T10:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([
        { id: 'al-1', site_id: 'site-1', kind: 'vencida', attended_at: attendedAt },
      ]);
    const { service } = servicio(query);

    await expect(
      service.atender('al-1', 'sup-1', '  Llamé al guardia, cerró la ronda a mano  '),
    ).resolves.toEqual({
      id: 'al-1',
      kind: 'vencida',
      attendedAt,
      attendedById: 'sup-1',
      attendedComment: 'Llamé al guardia, cerró la ronda a mano',
    });
    // El comentario se guarda recortado: el CHECK de la tabla exige trim >= 3.
    expect(query.mock.calls[1][1]).toEqual([
      'al-1',
      'sup-1',
      'Llamé al guardia, cerró la ronda a mano',
    ]);
  });

  it('atender dos veces es 409: manda el primero', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([]); // el UPDATE no tocó filas
    const { service } = servicio(query);

    await expect(service.atender('al-1', 'otro-sup', 'Ya estaba')).rejects.toThrow(
      ConflictException,
    );
  });

  it('una alerta inexistente es 404, no 409', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.atender('al-x', 'sup-1', 'Nada')).rejects.toThrow(NotFoundException);
  });

  it('no se puede atender la alerta de un recinto que no se supervisa', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ site_id: 'site-ajeno' }]);
    const { service, ensureAssignedSite } = servicio(query);
    ensureAssignedSite.mockRejectedValueOnce(new ForbiddenException('No tienes este recinto asignado'));

    await expect(service.atender('al-1', 'sup-1', 'Intento')).rejects.toThrow(ForbiddenException);
    // Solo alcanzó a leer el recinto de la alerta: no escribió nada.
    expect(query).toHaveBeenCalledTimes(1);
  });
});

/**
 * Guarda contra la trampa del driver: `manager.query()` de un UPDATE o un
 * DELETE devuelve `[filas, rowCount]` y no un arreglo plano, asi que un mock
 * que devuelve `[{...}]` deja el test verde y la respuesta rota. La defensa es
 * que ninguna escritura se lea directo: van envueltas en CTE y se leen con un
 * SELECT. Este test falla si alguien agrega un UPDATE suelto.
 */
describe('AlertasRondaService — forma real del driver', () => {
  it('ninguna sentencia lee filas de un UPDATE o un DELETE sin envolverlo', async () => {
    const query = jest
      .fn()
      // listar -> evaluarRecinto
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'al-1',
          site_id: 'site-1',
          kind: 'vencida',
          severity: 'alta',
          patrol_id: 'ronda-1',
          field_event_id: null,
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'sup-1' }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', name: 'Planta Sur' }])
      // listar -> tablero y conteos
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // atender
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([
        { id: 'al-1', site_id: 'site-1', kind: 'vencida', attended_at: new Date() },
      ]);
    const { service } = servicio(query);

    await service.listar('site-1', 'sup-1', true);
    await service.atender('al-1', 'sup-1', 'Revisado');

    for (const sql of SQLS(query)) {
      const primeraPalabra = sql.trim().split(/\s+/)[0]?.toUpperCase();
      expect(primeraPalabra).not.toBe('UPDATE');
      expect(primeraPalabra).not.toBe('DELETE');
    }
  });
});
