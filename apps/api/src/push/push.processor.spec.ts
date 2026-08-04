import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';

import { deepLinkDeRonda } from './deep-link';
import type { PushNotification, PushProvider, PushResult } from './push-provider';
import type { PushJobData } from './push-queue.types';
import { PushProcessor } from './push.processor';

const TENANT = '00000000-0000-4000-8000-000000000001';

const AVISO: PushNotification = {
  title: 'Ronda vencida en Planta Sur',
  body: 'La ronda pasó su duración máxima sin cerrarse.',
  deepLink: deepLinkDeRonda(
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ),
  urgency: 'normal',
};

function trabajo(): Job<PushJobData> {
  return {
    id: 'job-1',
    data: { tenantId: TENANT, userId: 'sup-1', notification: AVISO },
    opts: { attempts: 3 },
    attemptsMade: 0,
  } as unknown as Job<PushJobData>;
}

function procesador(query: jest.Mock, resultados: readonly PushResult[]) {
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
  const send = jest.fn().mockResolvedValue(resultados);
  const processor = new PushProcessor(dataSource, { send } as unknown as PushProvider);
  return { processor, send, runner };
}

describe('PushProcessor — entrega (#113)', () => {
  it('resuelve los tokens del destinatario en su propia transacción con tenant', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: 'tok-1' }, { token: 'tok-2' }]);
    const { processor, send, runner } = procesador(query, [
      { token: 'tok-1', verdict: 'entregado' },
      { token: 'tok-2', verdict: 'entregado' },
    ]);

    await expect(processor.process(trabajo())).resolves.toEqual({ delivered: 2, removed: 0 });

    // set_config(..., true) es SET LOCAL: la variable muere con la transaccion
    // y el proximo job no hereda el tenant del anterior.
    const [contexto, parametros] = query.mock.calls[0] ?? [];
    expect(String(contexto)).toContain(`set_config('app.tenant_id', $1, true)`);
    expect(parametros).toEqual([TENANT]);
    expect(String(query.mock.calls[1]?.[0])).toContain('tenant_id = app_tenant_id()');
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(['tok-1', 'tok-2'], AVISO, TENANT);
  });

  it('borra los tokens que el transporte declaró inexistentes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: 'tok-vivo' }, { token: 'tok-muerto' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { processor } = procesador(query, [
      { token: 'tok-vivo', verdict: 'entregado' },
      { token: 'tok-muerto', verdict: 'token-invalido', detail: 'UNREGISTERED' },
    ]);

    await expect(processor.process(trabajo())).resolves.toEqual({ delivered: 1, removed: 1 });

    const [sql, parametros] = query.mock.calls[3] ?? [];
    expect(String(sql)).toContain('DELETE FROM device_tokens');
    expect(String(sql)).toContain('tenant_id = app_tenant_id()');
    expect(parametros).toEqual([['tok-muerto']]);
  });

  it('un token muerto no se lleva puesto al aviso: no reintenta si alguno entregó', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: 'tok-1' }, { token: 'tok-2' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { processor } = procesador(query, [
      { token: 'tok-1', verdict: 'entregado' },
      { token: 'tok-2', verdict: 'reintentable', detail: 'UNAVAILABLE' },
    ]);

    // Reintentar por el segundo telefono repetiria la alerta en el primero, y
    // un panico duplicado entrena a ignorar el siguiente.
    await expect(processor.process(trabajo())).resolves.toEqual({ delivered: 1, removed: 0 });
  });

  it('si no llegó a ningún dispositivo falla para que BullMQ reintente', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: 'tok-1' }]);
    const { processor } = procesador(query, [
      { token: 'tok-1', verdict: 'reintentable', detail: 'INTERNAL' },
    ]);

    await expect(processor.process(trabajo())).rejects.toThrow('push_no_entregado');
  });

  it('un destinatario sin dispositivos no es una falla y no llama al transporte', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { processor, send } = procesador(query, []);

    await expect(processor.process(trabajo())).resolves.toEqual({ delivered: 0, removed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('todos los tokens muertos: se borran y no se reintenta un envío sin destino', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ token: 'tok-muerto' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { processor } = procesador(query, [
      { token: 'tok-muerto', verdict: 'token-invalido', detail: 'INVALID_ARGUMENT' },
    ]);

    // Reintentar no cambiaria nada: el dispositivo ya no existe.
    await expect(processor.process(trabajo())).resolves.toEqual({ delivered: 0, removed: 1 });
  });
});
