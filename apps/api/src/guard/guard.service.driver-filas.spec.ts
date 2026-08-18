import { ConflictException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EscalationService } from '../escalation/escalation.service';
import type { GpsPolicyService } from '../geo/gps-policy.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { EnvioInformeService } from '../reports/envio-informe.service';
import type { RulesService } from '../rules/rules.service';
import { GuardService } from './guard.service';

/**
 * Regresion de la forma que devuelve el driver: un UPDATE devuelve
 * **[filas, rowCount]**, no filas. `filas[0]` era el ARREGLO de filas —truthy
 * aunque venga vacio—, asi que marcar salida sin jornada abierta respondia 200
 * con `assignmentId: undefined`.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

function servicio(query: jest.Mock) {
  return new GuardService(
    { manager: { query } } as unknown as TenantContextService,
    { enqueue: jest.fn() } as unknown as MailQueueService,
    { effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) } as unknown as RulesService,
    { notify: jest.fn().mockResolvedValue(0) } as unknown as EscalationService,
    { assertPatrolStartAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as GpsPolicyService,
    { alCerrarRonda: jest.fn().mockResolvedValue({ jobId: 'job' }) } as unknown as EnvioInformeService,
  );
}

describe('GuardService.endShift — forma real del driver', () => {
  it('marcar salida sin jornada abierta es 409, no un 200 sin assignmentId', async () => {
    const service = servicio(jest.fn().mockResolvedValueOnce(comoDriver([])));

    await expect(service.endShift('guard-1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('marcar salida de la jornada abierta devuelve su id', async () => {
    const service = servicio(
      jest.fn().mockResolvedValueOnce(comoDriver([{ id: 'asignacion-1' }])),
    );

    await expect(service.endShift('guard-1', { latitude: -33.4, longitude: -70.6 })).resolves.toEqual({
      assignmentId: 'asignacion-1',
      status: 'cerrado',
      onDuty: false,
    });
  });
});
