import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { deepLinkDeEvento } from './deep-link';
import type { PushNotification } from './push-provider';
import { PUSH_JOB_ATTEMPTS, PUSH_JOB_BACKOFF_MS, PUSH_JOB_NAME } from './push-queue.constants';
import type { PushJobData } from './push-queue.types';
import { PushService } from './push.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
// A proposito NO se parece a un token real de FCM: una cadena aleatoria aqui
// dispara el escaner de secretos del historial y bloquea el PR. El servicio no
// valida el formato (ver register-device.dto.ts), asi que legible sirve igual.
const TOKEN = 'token-de-dispositivo-de-prueba';

const AVISO: PushNotification = {
  title: 'Pánico en Planta Sur',
  body: 'Atiende ahora. El detalle está en el panel.',
  deepLink: deepLinkDeEvento(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ),
  urgency: 'alta',
  collapseKey: 'evento:11111111-1111-4111-8111-111111111111',
};

function servicio(query: jest.Mock, add = jest.fn().mockResolvedValue({ id: 'job' })) {
  const service = new PushService(
    { manager: { query } } as unknown as TenantContextService,
    { add } as unknown as Queue<PushJobData>,
  );
  return { service, add };
}

describe('PushService — registro de dispositivos (#113)', () => {
  it('reasigna el token al usuario que registra, en vez de duplicarlo', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await expect(service.register('user-1', TOKEN, 'android', '0.1.0')).resolves.toEqual({
      registered: true,
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('ON CONFLICT (tenant_id, token) DO UPDATE');
    // El telefono de la empresa pasa de un turno al siguiente: el token queda
    // con el usuario nuevo y el anterior deja de recibir sus alertas.
    expect(String(sql)).toContain('user_id = EXCLUDED.user_id');
    expect(String(sql)).toContain('app_tenant_id()');
    expect(params).toEqual(['user-1', TOKEN, 'android', '0.1.0']);
  });

  it('no devuelve el token en la respuesta', async () => {
    const { service } = servicio(jest.fn().mockResolvedValue([]));
    const respuesta = await service.register('user-1', TOKEN, 'android');

    expect(JSON.stringify(respuesta)).not.toContain(TOKEN);
  });

  it('la baja exige que el token sea del propio usuario', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'device-1' }]);
    const { service } = servicio(query);

    await expect(service.unregister(TOKEN, 'user-1')).resolves.toEqual({ removed: true });

    const [sql, params] = query.mock.calls[0] ?? [];
    // Sin el filtro por usuario, cualquiera del tenant podria silenciar el
    // telefono de su supervisor.
    expect(String(sql)).toContain('user_id = $2');
    expect(params).toEqual([TOKEN, 'user-1']);
  });

  it('la baja repetida no es un error: el cierre de sesión se reintenta offline', async () => {
    const { service } = servicio(jest.fn().mockResolvedValue([]));

    await expect(service.unregister(TOKEN, 'user-1')).resolves.toEqual({ removed: false });
  });
});

describe('PushService — encolado (#113)', () => {
  it('encola un job por destinatario con dispositivo y saltea al resto', async () => {
    const query = jest.fn().mockResolvedValue([
      { tenant_id: TENANT, user_id: 'sup-1' },
      { tenant_id: TENANT, user_id: 'sup-2' },
    ]);
    const { service, add } = servicio(query);

    await expect(
      service.send(['sup-1', 'sup-2', 'admin-solo-correo'], AVISO, {
        idempotencyKey: 'panico:ev-1',
      }),
    ).resolves.toEqual({ enqueued: 2 });

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      PUSH_JOB_NAME,
      { tenantId: TENANT, userId: 'sup-1', notification: AVISO },
      expect.objectContaining({
        attempts: PUSH_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: PUSH_JOB_BACKOFF_MS },
        removeOnComplete: false,
        removeOnFail: false,
      }),
    );
  });

  it('la clave de idempotencia incluye al destinatario y no viaja en claro', async () => {
    const query = jest.fn().mockResolvedValue([{ tenant_id: TENANT, user_id: 'sup-1' }]);
    const { service, add } = servicio(query);

    await service.send(['sup-1'], AVISO, { idempotencyKey: 'panico:ev-1' });
    await service.send(['sup-1'], AVISO, { idempotencyKey: 'panico:ev-1' });

    const esperado = createHash('sha256').update('panico:ev-1:sup-1').digest('hex');
    const opciones = add.mock.calls.map((llamada) => llamada[2] as { jobId: string });
    expect(opciones[0]?.jobId).toBe(esperado);
    expect(opciones[1]?.jobId).toBe(esperado);
    expect(esperado).not.toContain('sup-1');
  });

  it('el job no lleva tokens: Redis conserva los completados para siempre', async () => {
    const query = jest.fn().mockResolvedValue([{ tenant_id: TENANT, user_id: 'sup-1' }]);
    const { service, add } = servicio(query);

    await service.send(['sup-1'], AVISO, { idempotencyKey: 'panico:ev-1' });

    expect(JSON.stringify(add.mock.calls[0]?.[1])).not.toContain(TOKEN);
    expect(add.mock.calls[0]?.[1]).not.toHaveProperty('tokens');
  });

  it('sin destinatarios no consulta la base', async () => {
    const query = jest.fn();
    const { service, add } = servicio(query);

    await expect(service.send([], AVISO, { idempotencyKey: 'panico:ev-1' })).resolves.toEqual({
      enqueued: 0,
    });
    expect(query).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('si la cola falla no arrastra al hecho de negocio', async () => {
    const query = jest.fn().mockResolvedValue([{ tenant_id: TENANT, user_id: 'sup-1' }]);
    const add = jest.fn().mockRejectedValue(new Error('redis caido'));
    const { service } = servicio(query, add);

    // El panico ya quedo registrado y el correo ya salio: perder el push es
    // degradar el aviso, no perder el evento.
    await expect(
      service.send(['sup-1'], AVISO, { idempotencyKey: 'panico:ev-1' }),
    ).resolves.toEqual({ enqueued: 0 });
  });
});
