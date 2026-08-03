import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { EscalationService } from './escalation.service';

/**
 * Las reglas de escalamiento se agregan a patrolRulesSchema (ver INTEGRACION.md).
 * Se mezclan aca para que el test describa el contrato que el servicio consume.
 */
const REGLAS = {
  ...patrolRulesSchema.parse({}),
  escalationCriticalities: ['alta', 'panico'],
  escalationDefaultDelayMin: 10,
} as unknown as PatrolRules;

function servicio(query: jest.Mock, enqueue = jest.fn().mockResolvedValue({ jobId: 'mail-job' })) {
  const service = new EscalationService(
    { manager: { query } } as unknown as TenantContextService,
    { enqueue } as unknown as MailQueueService,
    { effective: jest.fn().mockResolvedValue(REGLAS) } as unknown as RulesService,
  );
  return { service, enqueue };
}

describe('EscalationService — cadena configurable (#126)', () => {
  it('sin filas configuradas usa la cadena por defecto', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.policiesFor('panico')).resolves.toEqual([
      { level: 1, notifyRole: 'SUPERVISOR', notifyEmail: null, delayMinutes: 0, isDefault: true },
      { level: 2, notifyRole: 'ADMIN', notifyEmail: null, delayMinutes: 10, isDefault: true },
    ]);
  });

  it('la cadena del tenant manda sobre el default y respeta el orden de niveles', async () => {
    const query = jest.fn().mockResolvedValueOnce([
      { level: 1, notify_role: null, notify_email: 'central@monitoreo.cl', delay_minutes: 0 },
      { level: 2, notify_role: 'ADMIN', notify_email: null, delay_minutes: 5 },
    ]);
    const { service } = servicio(query);

    await expect(service.policiesFor('alta')).resolves.toEqual([
      {
        level: 1,
        notifyRole: null,
        notifyEmail: 'central@monitoreo.cl',
        delayMinutes: 0,
        isDefault: false,
      },
      { level: 2, notifyRole: 'ADMIN', notifyEmail: null, delayMinutes: 5, isDefault: false },
    ]);
  });

  it('notifica el nivel 1 y deja una fila de acuse por destinatario', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ level: 1, notify_role: 'SUPERVISOR', notify_email: null, delay_minutes: 0 }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', site_name: 'Planta Sur', guard_name: 'Ana Díaz' }])
      .mockResolvedValueOnce([{ id: 'sup-1', email: 'sup@empresa.cl' }])
      .mockResolvedValueOnce([{ id: 'notif-1' }]);
    const { service, enqueue } = servicio(query);

    await expect(
      service.notify('ev-1', 'panico', { siteId: 'site-1', guardId: 'guard-1' }),
    ).resolves.toBe(1);

    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO event_notifications'),
    );
    expect(insert[1]).toEqual(['ev-1', 1, 'sup-1', 'sup@empresa.cl']);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sup@empresa.cl', tenantId: 't-1' }),
      { idempotencyKey: 'escalation:ev-1:1:sup@empresa.cl' },
    );
  });

  it('una criticidad fuera de la regla del tenant no escala ni consulta la cadena', async () => {
    const query = jest.fn();
    const { service, enqueue } = servicio(query);

    await expect(
      service.notify('ev-1', 'media', { siteId: 'site-1', guardId: 'guard-1' }),
    ).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sin destinatarios no inventa correos ni filas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ level: 1, notify_role: 'SUPERVISOR', notify_email: null, delay_minutes: 0 }])
      .mockResolvedValueOnce([{ tenant_id: 't-1', site_name: 'Planta Sur', guard_name: 'Ana Díaz' }])
      .mockResolvedValueOnce([]);
    const { service, enqueue } = servicio(query);

    await expect(
      service.notify('ev-1', 'alta', { siteId: 'site-1', guardId: 'guard-1' }),
    ).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('EscalationService — acuse de recibo (#126)', () => {
  it('el primer acuse queda registrado con quien lo tomó', async () => {
    const acknowledgedAt = new Date('2026-08-03T12:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'notif-1', field_event_id: 'ev-1', level: 1, acknowledged_at: acknowledgedAt },
      ]);
    const { service } = servicio(query);

    await expect(service.acknowledge('notif-1', 'user-1')).resolves.toEqual({
      id: 'notif-1',
      eventId: 'ev-1',
      level: 1,
      acknowledgedAt,
      acknowledgedBy: 'user-1',
    });
  });

  it('acusar dos veces es 409: el primero se hizo cargo', async () => {
    // El UPDATE no toca filas y la notificación existe: ya la acusaron.
    const yaAcusada = () =>
      jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ acknowledged_at: new Date() }]);

    await expect(
      servicio(yaAcusada()).service.acknowledge('notif-1', 'otro-user'),
    ).rejects.toThrow(ConflictException);
    await expect(
      servicio(yaAcusada()).service.acknowledge('notif-1', 'otro-user'),
    ).rejects.toThrow('Esa alerta ya tiene acuse de recibo');
  });

  it('una notificación inexistente es 404, no 409', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.acknowledge('notif-x', 'user-1')).rejects.toThrow(NotFoundException);
  });
});

describe('EscalationService — falsa alarma (#127)', () => {
  const original = {
    id: 'ev-1',
    site_id: 'site-1',
    patrol_id: 'patrol-1',
    guard_id: 'guard-1',
    criticality: 'panico',
  };

  it('crea una entrada nueva que corrige, sin mutar la original', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([{ id: 'corr-1' }])
      .mockResolvedValueOnce([]); // nadie fue notificado todavía
    const { service } = servicio(query);

    await expect(
      service.cancelAsFalseAlarm('ev-1', 'guard-1', '  Fue el gato en el sensor  '),
    ).resolves.toMatchObject({ eventId: 'ev-1', correctionId: 'corr-1', replay: false });

    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO field_events'),
    );
    expect(insert[0]).toContain('corrects_event_id');
    expect(insert[1][3]).toBe('Fue el gato en el sensor');
    expect(insert[1][4]).toBe('ev-1');

    const sqls = query.mock.calls.map(([sql]: [string]) => sql);
    expect(sqls.some((sql: string) => /UPDATE\s+field_events/.test(sql))).toBe(false);
    expect(sqls.some((sql: string) => /DELETE\s+FROM\s+field_events/.test(sql))).toBe(false);
  });

  it('reenviar la cancelación devuelve la corrección existente, no una segunda entrada', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([]) // ON CONFLICT DO NOTHING
      .mockResolvedValueOnce([{ id: 'corr-1' }]);
    const { service } = servicio(query);

    await expect(
      service.cancelAsFalseAlarm('ev-1', 'guard-1', 'Fue el gato'),
    ).resolves.toEqual({ eventId: 'ev-1', correctionId: 'corr-1', replay: true, notified: 0 });
  });

  it('avisa a quienes ya salieron a atender el pánico', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([{ id: 'corr-1' }])
      .mockResolvedValueOnce([{ id: 'notif-1', recipient_email: 'sup@empresa.cl' }])
      .mockResolvedValueOnce([
        { tenant_id: 't-1', site_name: 'Planta Sur', guard_name: 'Ana Díaz' },
      ]);
    const { service, enqueue } = servicio(query);

    await expect(
      service.cancelAsFalseAlarm('ev-1', 'guard-1', 'Fue el gato'),
    ).resolves.toMatchObject({ notified: 1 });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sup@empresa.cl' }),
      { idempotencyKey: 'false-alarm:corr-1:notif-1' },
    );
  });

  it('otro guardia no puede cancelar el evento ajeno', async () => {
    const query = jest.fn().mockResolvedValueOnce([original]);
    const { service } = servicio(query);

    await expect(service.cancelAsFalseAlarm('ev-1', 'guard-2', 'Fue el gato')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('un evento inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.cancelAsFalseAlarm('ev-x', 'guard-1', 'Fue el gato')).rejects.toThrow(
      NotFoundException,
    );
  });
});
