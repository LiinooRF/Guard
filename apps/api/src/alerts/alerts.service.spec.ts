import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { PushService } from '../push/push.service';
import { ALERTS_JOB_NAME } from './alerts-queue.constants';
import { AlertsService } from './alerts.service';

const PATROL = {
  tenant_id: 'tenant-1', site_id: 'site-1', site_name: 'Planta Sur',
  route_name: 'Perímetro', guard_name: 'Ana Díaz', status: 'pendiente',
  scheduled_start_at: new Date(Date.now() + 60_000),
  scheduled_end_at: new Date(Date.now() + 3_600_000), entry_tolerance_min: 5,
};

function setup(query: jest.Mock) {
  const push = { send: jest.fn().mockResolvedValue({ enqueued: 1 }) } as unknown as PushService;
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) } as unknown as Queue;
  const service = new AlertsService(
    { manager: { query } } as unknown as TenantContextService, push, queue,
  );
  return { service, push, queue };
}

describe('AlertsService', () => {
  it('programa los controles de inicio y vencimiento al crear la ronda', async () => {
    const query = jest.fn().mockResolvedValueOnce([PATROL]);
    const { service, queue } = setup(query);

    await service.schedulePatrol('patrol-1');

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(1, ALERTS_JOB_NAME,
      { tenantId: 'tenant-1', patrolId: 'patrol-1', kind: 'no_iniciada' },
      expect.objectContaining({ attempts: 5, delay: expect.any(Number), removeOnComplete: false }),
    );
    expect(queue.add).toHaveBeenNthCalledWith(2, ALERTS_JOB_NAME,
      { tenantId: 'tenant-1', patrolId: 'patrol-1', kind: 'atrasada' },
      expect.objectContaining({ attempts: 5, delay: expect.any(Number), removeOnFail: false }),
    );
  });

  it('crea una alerta no iniciada una sola vez y avisa solo a supervisores del recinto', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{ id: 'alert-1' }])
      .mockResolvedValueOnce([{ supervisor_id: 'sup-1' }, { supervisor_id: 'sup-2' }]);
    const { service, push } = setup(query);

    await expect(service.detectScheduled('patrol-1', 'no_iniciada'))
      .resolves.toEqual({ created: true, id: 'alert-1' });
    expect(query.mock.calls[1]?.[0]).toContain('ON CONFLICT (tenant_id, dedupe_key) DO NOTHING');
    expect(push.send).toHaveBeenCalledWith(['sup-1', 'sup-2'], expect.objectContaining({
      title: 'Ronda no iniciada a tiempo', urgency: 'normal',
    }), { idempotencyKey: 'operational-alert:alert-1' });
  });

  it('no alerta si la ronda ya comenzó y no duplica un escaneo anómalo', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ ...PATROL, status: 'en_curso' }])
      .mockResolvedValueOnce([{ ...PATROL, status: 'en_curso' }])
      .mockResolvedValueOnce([]);
    const { service, push } = setup(query);

    await expect(service.detectScheduled('patrol-1', 'no_iniciada'))
      .resolves.toEqual({ created: false, reason: 'already_started' });
    await service.recordAnomaly('patrol-1', 'scan-1', ['sin_fix_gps']);
    expect(push.send).not.toHaveBeenCalled();
  });

  it('lista exclusivamente mediante la asignación supervisor-recinto', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      id: 'alert-1', alert_type: 'atrasada', severity: 'critica', title: 'Ronda atrasada',
      details: null, site_id: 'site-1', site_name: 'Planta Sur', patrol_id: 'patrol-1',
      field_event_id: null, detected_at: new Date('2026-08-04T03:00:00Z'), attended_at: null,
      attendance_comment: null, attended_by_name: null,
    }]);
    const { service } = setup(query);

    await expect(service.list('sup-1')).resolves.toEqual([
      expect.objectContaining({ id: 'alert-1', type: 'atrasada', siteName: 'Planta Sur' }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      'scope.supervisor_id = $1'), ['sup-1']);
  });

  it('registra actor y comentario y distingue alerta ajena de alerta ya atendida', async () => {
    const success = setup(jest.fn().mockResolvedValueOnce([{ attended_at: new Date() }]));
    await success.service.attend('alert-1', 'sup-1', ' Guardia contactado ');
    expect((success.service as unknown as { tenantContext: TenantContextService }).tenantContext
      .manager.query).toHaveBeenCalledWith(expect.stringContaining('attendance_comment = trim($3)'),
      ['alert-1', 'sup-1', ' Guardia contactado ']);

    const absent = setup(jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]));
    await expect(absent.service.attend('alert-2', 'sup-1', 'Revisado'))
      .rejects.toBeInstanceOf(NotFoundException);

    const attended = setup(jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
      { attended_at: new Date() },
    ]));
    await expect(attended.service.attend('alert-1', 'sup-1', 'Revisado'))
      .rejects.toBeInstanceOf(ConflictException);
  });
});
