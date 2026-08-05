import type { Queue } from 'bullmq';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { PushJobData } from './push-queue.types';
import { PushService } from './push.service';

// A proposito NO se parece a un token real de FCM: una cadena aleatoria aqui
// dispara el escaner de secretos del historial y bloquea el PR.
const TOKEN = 'token-de-dispositivo-de-prueba';

/**
 * Regresion de la forma que devuelve el driver: un DELETE devuelve
 * **[filas, rowCount]**, no filas. Leido como arreglo media 2 siempre, asi que
 * `removed` salia true aunque no se borrara nada.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

function servicio(query: jest.Mock) {
  return new PushService(
    { manager: { query } } as unknown as TenantContextService,
    { add: jest.fn() } as unknown as Queue<PushJobData>,
  );
}

describe('PushService.unregister — forma real del driver', () => {
  it('si el token no era de este usuario responde removed: false', async () => {
    const service = servicio(jest.fn().mockResolvedValueOnce(comoDriver([])));

    await expect(service.unregister(TOKEN, 'user-1')).resolves.toEqual({ removed: false });
  });

  it('si borro el token responde removed: true', async () => {
    const service = servicio(jest.fn().mockResolvedValueOnce(comoDriver([{ id: 'device-1' }])));

    await expect(service.unregister(TOKEN, 'user-1')).resolves.toEqual({ removed: true });
  });
});
