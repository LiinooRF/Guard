import type { GpsPolicyService } from '../geo/gps-policy.service';
import type { EnvioInformeService } from '../reports/envio-informe.service';
import { GuardService } from './guard.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EscalationService } from '../escalation/escalation.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { patrolRulesSchema } from '@sentrycore/shared';

const sinCorreo = () =>
  ({ enqueue: jest.fn().mockResolvedValue({ jobId: 'mail-job' }) }) as unknown as MailQueueService;
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as unknown as RulesService;

/**
 * La puerta de GPS (#77) se prueba entera en gps-policy.service.spec.ts. Aca
 * solo tiene que dejar pasar: si estos tests dependieran de su veredicto,
 * probarian dos cosas a la vez y fallarian por el motivo equivocado.
 */
/**
 * El envio del informe se prueba entero en el carril de #86. Aca solo tiene que
 * dejarse llamar: si estos tests dependieran de que encole, probarian dos cosas
 * a la vez y fallarian por el motivo equivocado.
 */
const sinEnvioInforme = () =>
  ({ alCerrarRonda: jest.fn().mockResolvedValue({ jobId: 'job' }) }) as unknown as EnvioInformeService;

const sinPuertaGps = () =>
  ({ assertPatrolStartAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as GpsPolicyService;

const sinEscalamiento = (notificados = 0) =>
  ({ notify: jest.fn().mockResolvedValue(notificados) }) as unknown as EscalationService;

function servicio(query: jest.Mock) {
  return new GuardService({ manager: { query } } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());
}

describe('GuardService — jornada (#131)', () => {
  it('marcar entrada deja al guardia en servicio', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'asig-1', status: 'asignado', shift_name: 'Nocturno' }])
      .mockResolvedValueOnce([]);
    await expect(
      servicio(query).startShift('guard-id', { latitude: -33.45, longitude: -70.66 }),
    ).resolves.toMatchObject({ assignmentId: 'asig-1', status: 'en_curso', onDuty: true });
  });

  it('sin turno asignado no se puede marcar entrada', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(servicio(query).startShift('guard-id', {})).rejects.toThrow(
      'No tienes un turno asignado para marcar entrada',
    );
  });

  it('marcar salida sin jornada abierta es un conflicto, no un cierre silencioso', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // el UPDATE no toco filas
    await expect(servicio(query).endShift('guard-id', {})).rejects.toThrow(
      'No tienes una jornada abierta',
    );
  });

  it('marcar salida cierra la jornada en curso', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'asig-1' }]);
    await expect(servicio(query).endShift('guard-id', {})).resolves.toMatchObject({
      assignmentId: 'asig-1',
      status: 'cerrado',
      onDuty: false,
    });
  });
});

describe('GuardService — ronda voluntaria (#133)', () => {
  it('queda marcada como voluntaria y se cuelga de la jornada abierta', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'route-1', site_id: 'site-1' }]) // ruta activa
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }, { checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([{ id: 'asig-1' }]) // jornada en curso
      .mockResolvedValueOnce([]); // INSERT
    const service = servicio(query);

    await expect(service.startVoluntaryPatrol('guard-id', 'route-1')).resolves.toMatchObject({
      status: 'en_curso',
      isVoluntary: true,
      expectedCheckpoints: 2,
    });
    const insert = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO patrols'));
    expect(insert[0]).toContain('is_voluntary');
    expect(insert[1][5]).toBe('asig-1');
  });

  it('sin jornada abierta igual se puede: la ronda voluntaria no exige turno', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'route-1', site_id: 'site-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }, { checkpoint_id: 'cp-2' }])
      .mockResolvedValueOnce([]) // sin jornada
      .mockResolvedValueOnce([]);
    await expect(
      servicio(query).startVoluntaryPatrol('guard-id', 'route-1'),
    ).resolves.toMatchObject({ isVoluntary: true });
  });

  it('una ruta sin secuencia valida se rechaza', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'route-1', site_id: 'site-1' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1' }]); // solo 1 punto
    await expect(servicio(query).startVoluntaryPatrol('guard-id', 'route-1')).rejects.toThrow(
      'La ruta no tiene una secuencia valida',
    );
  });
});
