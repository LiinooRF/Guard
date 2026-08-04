import type { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'node:crypto';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { contenidoFirmado, DeviceSignatureService } from './device-signature.service';
import type { CreateScanDto } from './dto/create-scan.dto';

const DEVICE = '4a0c8f7e-1111-4222-8333-444455556666';
const CLIENT = '3a0c8f7e-1111-4222-8333-444455556666';

function setup() {
  let encrypted: Buffer | undefined;
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO device_signing_keys')) {
      encrypted = params[2] as Buffer;
      return [];
    }
    if (sql.includes('SELECT encrypted_key')) {
      return encrypted ? [{ encrypted_key: encrypted }] : [];
    }
    if (sql.includes('SELECT EXISTS')) {
      return [{ exists: Boolean(encrypted) }];
    }
    return [];
  });
  const config = {
    getOrThrow: jest.fn().mockReturnValue('secreto-de-test-con-mas-de-32-caracteres'),
  } as unknown as ConfigService;
  const service = new DeviceSignatureService(
    { manager: { query } } as unknown as TenantContextService,
    config,
  );
  return { service, encrypted: () => encrypted, query };
}

function scan(signature = ''): CreateScanDto {
  return {
    uid: '04AABBCC', method: 'nfc', clientScanId: CLIENT,
    scannedAt: '2026-08-04T01:00:00.000Z', latitude: -33.45,
    longitude: -70.66, accuracyM: 8, deviceId: DEVICE, signature,
  };
}

test('cifra la clave enrolada y acepta una firma HMAC válida', async () => {
  const { service, encrypted, query } = setup();
  const key = randomBytes(32);
  await service.enroll('guard-id', DEVICE, key.toString('base64'));
  assertEncrypted(encrypted(), key);

  const input = scan();
  input.signature = createHmac('sha256', key).update(contenidoFirmado(input)).digest('hex');
  await expect(service.verify('guard-id', input)).resolves.toBe('verificada');
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('last_used_at = now()'), ['guard-id', DEVICE],
  );
});

test('marca como legacy solo mientras el guardia aún no tenga una clave registrada', async () => {
  const { service } = setup();
  const unsigned = scan();
  delete unsigned.deviceId;
  delete unsigned.signature;

  await expect(service.verify('guard-id', unsigned)).resolves.toBe('legacy');
  await service.enroll('guard-id', DEVICE, randomBytes(32).toString('base64'));
  await expect(service.verify('guard-id', unsigned)).rejects.toMatchObject({ status: 403 });
});

test('rechaza si cambian GPS, UID o timestamp después de firmar', async () => {
  const { service } = setup();
  const key = randomBytes(32);
  await service.enroll('guard-id', DEVICE, key.toString('base64'));
  const original = scan();
  original.signature = createHmac('sha256', key)
    .update(contenidoFirmado(original)).digest('hex');

  await expect(service.verify('guard-id', { ...original, latitude: -34 }))
    .rejects.toMatchObject({ status: 403 });
  await expect(service.verify('guard-id', { ...original, uid: '04FFFFFF' }))
    .rejects.toMatchObject({ status: 403 });
  await expect(service.verify('guard-id', {
    ...original, scannedAt: '2026-08-04T02:00:00.000Z',
  })).rejects.toMatchObject({ status: 403 });
});

function assertEncrypted(value: Buffer | undefined, key: Buffer) {
  expect(value).toBeDefined();
  expect(value?.equals(key)).toBe(false);
  expect(value?.includes(key)).toBe(false);
}
