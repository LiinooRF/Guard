import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { deepLinkDeRonda } from './deep-link';
import type { PushNotification, PushProvider } from './push-provider';
import type { PushJobData } from './push-queue.types';
import { PushProcessor } from './push.processor';
import { PushService } from './push.service';

/**
 * "Un usuario dado de baja deja de recibir push" — criterio de aceptacion de #43.
 *
 * POR QUE HACEN FALTA LOS DOS FILTROS, Y NO UNO
 * ---------------------------------------------
 * Dar de baja a una persona (`AdminService.setUserActive(false)`) le revoca las
 * sesiones, pero NO le quita el token: la app sigue instalada en el telefono y
 * el token sigue siendo valido para el transporte. Sin filtro, el guardia
 * despedido sigue viendo en su pantalla bloqueada el recinto y la hora de las
 * rondas de la empresa.
 *
 *   - PushService.send filtra al ENCOLAR: no se genera basura retenida en Redis
 *     para alguien que ya no trabaja ahi.
 *   - PushProcessor filtra al ENTREGAR: entre encolar y entregar pasan minutos
 *     —el job reintenta con espera exponencial— y la baja puede ocurrir en el
 *     medio. Este es el que cierra el criterio de verdad, porque es el ultimo
 *     paso antes del transporte y no depende de que cada emisor se acuerde.
 *
 * Los dos son un `JOIN users ... AND usuario.is_active`, el mismo filtro que ya
 * usa SQL_DESTINATARIOS en alertas-ronda.service.ts. Se prueba sobre el TEXTO
 * del SQL porque el mock de `query` devuelve lo que se le pida: lo que se puede
 * verificar sin base es que la consulta lo lleve.
 */

const TENANT = '00000000-0000-4000-8000-000000000001';
const AVISO: PushNotification = {
  title: 'Tu ronda está por comenzar',
  body: 'Planta Sur: comienza a las 22:00.',
  deepLink: deepLinkDeRonda(
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ),
  urgency: 'alta',
};

describe('PushService.send — no encola para quien esta dado de baja', () => {
  function servicio(filas: Array<{ tenant_id: string; user_id: string }>) {
    const query = jest.fn().mockResolvedValue(filas);
    const add = jest.fn().mockResolvedValue({ id: 'job' });
    const service = new PushService(
      { manager: { query } } as unknown as TenantContextService,
      { add } as unknown as Queue<PushJobData>,
    );
    return { service, query, add };
  }

  it('la consulta exige que el destinatario siga activo', async () => {
    const { service, query } = servicio([{ tenant_id: TENANT, user_id: 'guardia-1' }]);

    await service.send(['guardia-1'], AVISO, { idempotencyKey: 'patrol-start:r-1' });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('JOIN users usuario ON usuario.id = dispositivo.user_id');
    expect(sql).toContain('usuario.is_active');
    // El aislamiento por empresa no se pierde al agregar el join.
    expect(sql).toContain('dispositivo.tenant_id = app_tenant_id()');
  });

  it('si la consulta no lo devuelve, no queda job retenido en Redis', async () => {
    // Un job por una persona dada de baja quedaria retenido para siempre
    // (removeOnComplete: false) sin haber servido para nada.
    const { service, add } = servicio([]);

    await expect(
      service.send(['guardia-dado-de-baja'], AVISO, { idempotencyKey: 'patrol-start:r-1' }),
    ).resolves.toEqual({ enqueued: 0 });
    expect(add).not.toHaveBeenCalled();
  });
});

describe('PushProcessor — no entrega a quien quedo dado de baja despues de encolar', () => {
  function procesador(tokens: Array<{ token: string }>) {
    const query = jest
      .fn()
      // set_config del contexto de tenant
      .mockResolvedValueOnce([])
      // resolucion de tokens
      .mockResolvedValueOnce(tokens);
    const runner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: { query },
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as unknown as DataSource;
    const send = jest.fn().mockResolvedValue([]);
    const processor = new PushProcessor(dataSource, { send } as unknown as PushProvider);
    const job = {
      id: 'job-1',
      data: { tenantId: TENANT, userId: 'guardia-1', notification: AVISO },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as unknown as Parameters<PushProcessor['process']>[0];
    return { processor, job, query, send };
  }

  it('la resolucion de tokens exige que el destinatario siga activo', async () => {
    const { processor, job, query } = procesador([{ token: 'tok-1' }]);

    await processor.process(job);

    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain('JOIN users usuario ON usuario.id = dispositivo.user_id');
    expect(sql).toContain('usuario.is_active');
    expect(sql).toContain('dispositivo.tenant_id = app_tenant_id()');
    // El orden por ultimo visto sobrevive al join: primero el telefono en uso.
    expect(sql).toContain('ORDER BY dispositivo.last_seen_at DESC');
  });

  it('sin tokens que entregar no llama al transporte y no falla el job', async () => {
    // Que no falle importa: un job que falla se reintenta tres veces y despues
    // queda en la dead-letter, y una baja no es un incidente de entrega.
    const { processor, job, send } = procesador([]);

    await expect(processor.process(job)).resolves.toEqual({ delivered: 0, removed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
