import { ConflictException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { EscalationService } from './escalation.service';

/**
 * Regresion de la forma que devuelve el driver: un UPDATE devuelve
 * **[filas, rowCount]**, no filas. `filas[0]` era entonces el ARREGLO de filas,
 * y un arreglo vacio es truthy: el segundo acuse se daba por bueno.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

const REGLAS = patrolRulesSchema.parse({}) as PatrolRules;

function servicio(query: jest.Mock) {
  return new EscalationService(
    { manager: { query } } as unknown as TenantContextService,
    { enqueue: jest.fn() } as unknown as MailQueueService,
    { effective: jest.fn().mockResolvedValue(REGLAS) } as unknown as RulesService,
  );
}

describe('EscalationService.acknowledge — forma real del driver', () => {
  it('el segundo acuse es 409, no un 200 con los campos en undefined', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(comoDriver([])) // UPDATE que no toca ninguna fila
      .mockResolvedValueOnce([{ acknowledged_at: new Date() }]); // la alerta existe
    const service = servicio(query);

    await expect(service.acknowledge('notif-1', 'user-2'))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('el primer acuse responde el evento y el nivel de verdad, no NaN', async () => {
    const acknowledgedAt = new Date('2026-08-04T23:10:00.000Z');
    const query = jest.fn().mockResolvedValueOnce(comoDriver([{
      id: 'notif-1',
      field_event_id: 'evento-1',
      level: 2,
      acknowledged_at: acknowledgedAt,
    }]));
    const service = servicio(query);

    await expect(service.acknowledge('notif-1', 'user-1')).resolves.toEqual({
      id: 'notif-1',
      eventId: 'evento-1',
      level: 2,
      acknowledgedAt,
      acknowledgedBy: 'user-1',
    });
  });
});
