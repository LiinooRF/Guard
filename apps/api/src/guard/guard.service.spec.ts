import { patrolRulesSchema } from '@voxia/shared';

import { GuardService } from './guard.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EscalationService } from '../escalation/escalation.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import type { AlertsService } from '../alerts/alerts.service';

const sinCorreo = () =>
  ({ enqueue: jest.fn().mockResolvedValue({ jobId: 'mail-job' }) }) as
    unknown as MailQueueService;

/** Motor de reglas sin overrides: responde los defaults del producto (#16). */
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as
    unknown as RulesService;

const sinEscalamiento = (notificados = 0) =>
  ({ notify: jest.fn().mockResolvedValue(notificados) }) as unknown as EscalationService;

const sinAlertas = () => ({
  recordAnomaly: jest.fn().mockResolvedValue(undefined),
  recordIncomplete: jest.fn().mockResolvedValue(undefined),
  recordSevereEvent: jest.fn().mockResolvedValue(undefined),
}) as unknown as AlertsService;

describe('GuardService', () => {
  it('indica claramente cuando el guardia no tiene turno', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: false,
      message: 'No tienes un turno asignado en este momento.',
    });
  });

  it('devuelve la ronda asignada sin datos de otros guardias', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'patrol-id',
          status: 'pendiente',
          scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
          scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
          started_at: null,
          site_name: 'Recinto demostración',
          route_name: 'Ronda nocturna demo',
          estimated_duration_min: 30,
          checkpoints: [
            { id: 'checkpoint-id', name: 'Acceso', position: 1, isClosingPoint: true },
          ],
        },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: true,
      patrol: {
        id: 'patrol-id',
        completedCheckpointCount: 0,
        checkpoints: [{ name: 'Acceso' }],
      },
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('p.guard_id = $1'), [
      'guard-id',
    ]);
  });

  it('inicia únicamente una ronda pendiente asignada al guardia autenticado', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        { id: 'patrol-id', status: 'en_curso', started_at: new Date() },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.startPatrol('patrol-id', 'guard-id')).resolves.toMatchObject({
      status: 'en_curso',
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pendiente'"), [
      'patrol-id',
      'guard-id',
    ]);
  });
});

describe('GuardService.registerScan', () => {
  const PATROL = {
    id: 'patrol-id',
    status: 'en_curso',
    route_id: 'route-id',
    expected_checkpoint_ids: ['cp-1', 'cp-2'],
  };
  const dto = (extra = {}) => ({
    uid: 'ABCD1234',
    method: 'nfc' as const,
    clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
    latitude: -33.45,
    longitude: -70.66,
    ...extra,
  });

  it('cierra la ronda sola al escanear el punto de cierre, con su cumplimiento', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL]) // la ronda del guardia
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'acceso_critico', latitude: '-33.45', longitude: '-70.66',
        is_closing_point: true,
      }]) // resolucion de la etiqueta
      .mockResolvedValueOnce([{ id: 'scan-id' }]) // insert
      .mockResolvedValueOnce([
        { checkpoint_id: 'cp-1', anomalies: [] },
        { checkpoint_id: 'cp-2', anomalies: [] },
      ]) // todos los escaneos de la ronda
      .mockResolvedValueOnce([]); // cierre
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      replay: false,
      patrol: { status: 'completada', compliancePct: 100 },
      progress: { scanned: 2, expected: 2, pct: 100 },
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'completada'"),
      ['patrol-id', 100],
    );
  });

  it('el reenvio offline es idempotente: mismo clientScanId no duplica ni re-cierra', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: null, longitude: null,
        is_closing_point: false,
      }])
      .mockResolvedValueOnce([]) // ON CONFLICT DO NOTHING: ya existia
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1', anomalies: [] }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      replay: true,
      patrol: { status: 'en_curso' },
      progress: { scanned: 1, expected: 2, pct: 50 },
    });
    // 4 queries: nunca intenta cerrar ni insertar de nuevo
    expect(manager.query).toHaveBeenCalledTimes(4);
  });

  it('rechaza la etiqueta de un punto que no pertenece a la ronda', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-x', checkpoint_id: 'cp-de-otro-recinto', checkpoint_name: 'Bodega ajena',
        kind: 'normal', latitude: null, longitude: null, is_closing_point: null,
      }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).rejects.toThrow(
      'El punto escaneado no pertenece a esta ronda',
    );
  });

  it('cerrar bajo el umbral alerta al admin, directo (#64)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL]) // la ronda
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'acceso_critico', latitude: null, longitude: null,
        is_closing_point: true,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }]) // insert
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2', anomalies: [] }]) // solo 1 de 2 -> 50%
      .mockResolvedValueOnce([]) // cierre
      .mockResolvedValueOnce([{
        tenant_id: 'tenant-1', site_name: 'Planta Norte',
        route_name: 'Nocturna', guard_name: 'Juan Soto',
      }]) // contexto de la alerta
      .mockResolvedValueOnce([{ id: 'admin-1', email: 'admin@empresa.test' }]); // admins
    const correo = sinCorreo();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({
      alertSent: true,
      patrol: { status: 'completada', compliancePct: 50 },
    });
    expect(correo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@empresa.test',
        tenantId: 'tenant-1',
        template: expect.objectContaining({ subject: expect.stringContaining('umbral') }),
        variables: expect.objectContaining({ pct: 50, threshold: 70, site: 'Planta Norte' }),
      }),
      { idempotencyKey: expect.stringContaining('patrol-low-compliance:patrol-id') },
    );
  });

  it('si el correo falla, el escaneo y el cierre NO se rompen', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'normal', latitude: null, longitude: null, is_closing_point: true,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2', anomalies: [] }])
      .mockResolvedValueOnce([]) // cierre
      .mockResolvedValueOnce([{
        tenant_id: 'tenant-1', site_name: 'Planta', route_name: 'Ruta', guard_name: 'Ana',
      }])
      .mockResolvedValueOnce([{ id: 'admin-1', email: 'admin@empresa.test' }]);
    const correo = { enqueue: jest.fn().mockRejectedValue(new Error('redis caido')) } as
      unknown as MailQueueService;
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({ patrol: { status: 'completada' } });
  });

  it('el boton de panico registra sin texto y delega el escalamiento (#123, #126)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }]) // ultima ronda
      .mockResolvedValueOnce([{ id: 'evento-id', reported_at_server: new Date() }]); // insert
    // Resolver destinatarios y armar el correo ya NO es tarea del guardia:
    // vive en EscalationService, que decide la cadena segun la regla del tenant.
    const escalamiento = sinEscalamiento(1);
    const correo = sinCorreo();
    const service = new GuardService(
      { manager } as unknown as TenantContextService,
      correo,
      sinReglas(),
      escalamiento,
      sinAlertas(),
    );

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'panico',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
        latitude: -33.45, longitude: -70.66,
      }),
    ).resolves.toMatchObject({ replay: false, notified: true, criticality: 'panico' });
    expect(escalamiento.notify).toHaveBeenCalledWith(
      'evento-id',
      'panico',
      expect.objectContaining({ siteId: 'site-id', guardId: 'guard-id' }),
    );
    // El correo lo encola la cadena, no el flujo del guardia.
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('reenviar el mismo evento no duplica la fila NI re-avisa (#123)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }])
      .mockResolvedValueOnce([]) // ON CONFLICT: ya existia
      .mockResolvedValueOnce([{ id: 'evento-id' }]); // busqueda del original
    const correo = sinCorreo();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'panico',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
      }),
    ).resolves.toMatchObject({ replay: true, notified: false, id: 'evento-id' });
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('una novedad informativa no molesta a nadie por correo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }])
      .mockResolvedValueOnce([{ id: 'evento-id', reported_at_server: new Date() }]);
    const correo = sinCorreo();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'info',
        text: 'Porton norte quedo con la luz quemada',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
      }),
    ).resolves.toMatchObject({ replay: false, notified: false });
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('marca sin_fix_gps cuando no vienen coordenadas, pero registra igual', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: '-33.45', longitude: '-70.66',
        is_closing_point: false,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1', anomalies: ['sin_fix_gps'] }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinAlertas());

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({
      replay: false,
      anomalies: ['sin_fix_gps'],
      patrol: { status: 'en_curso' },
    });
  });
});
