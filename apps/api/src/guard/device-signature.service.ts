import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreateScanDto } from './dto/create-scan.dto';

const VERSION = 'v1';

export function contenidoFirmado(input: Pick<CreateScanDto,
  'clientScanId' | 'deviceId' | 'uid' | 'method' | 'scannedAt' |
  'latitude' | 'longitude' | 'accuracyM'>): string {
  return JSON.stringify([
    VERSION,
    input.clientScanId,
    input.deviceId,
    input.uid.trim(),
    input.method,
    input.scannedAt ?? null,
    input.latitude ?? null,
    input.longitude ?? null,
    input.accuracyM ?? null,
  ]);
}

@Injectable()
export class DeviceSignatureService {
  private readonly master: Buffer;

  constructor(
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.master = createHash('sha256')
      .update('voxia:device-signing-keys:v1\0', 'utf8')
      .update(config.getOrThrow<string>('JWT_SECRET'), 'utf8')
      .digest();
  }

  async enroll(userId: string, deviceId: string, encodedKey: string) {
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length !== 32) throw new ForbiddenException('Clave de dispositivo inválida');
    const encrypted = this.encrypt(key);
    await this.tenantContext.manager.query(
      `INSERT INTO device_signing_keys (tenant_id, user_id, device_id, encrypted_key)
       VALUES (app_tenant_id(), $1, $2, $3)
       ON CONFLICT (tenant_id, user_id, device_id) DO UPDATE SET
         encrypted_key = excluded.encrypted_key,
         registered_at = now(),
         last_used_at = NULL`,
      [userId, deviceId, encrypted],
    );
    return { deviceId, algorithm: 'HMAC-SHA256' as const };
  }

  async verify(userId: string, input: CreateScanDto): Promise<'verificada' | 'legacy'> {
    if (!input.deviceId || !input.signature) {
      const registered = await this.tenantContext.manager.query<Array<{ exists: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM device_signing_keys WHERE user_id = $1
         ) AS exists`,
        [userId],
      );
      if (registered[0]?.exists) {
        throw new ForbiddenException('El escaneo no tiene firma del dispositivo');
      }
      return 'legacy';
    }
    const rows = await this.tenantContext.manager.query<Array<{ encrypted_key: Buffer }>>(
      `SELECT encrypted_key FROM device_signing_keys
       WHERE user_id = $1 AND device_id = $2`,
      [userId, input.deviceId],
    );
    if (!rows[0]) throw new ForbiddenException('Dispositivo no registrado');
    const expected = createHmac('sha256', this.decrypt(rows[0].encrypted_key))
      .update(contenidoFirmado(input), 'utf8').digest('hex');
    const received = Buffer.from(input.signature, 'hex');
    const valid = received.length === 32 && timingSafeEqual(Buffer.from(expected, 'hex'), received);
    if (!valid) throw new ForbiddenException('Firma de escaneo inválida');
    await this.tenantContext.manager.query(
      `UPDATE device_signing_keys SET last_used_at = now()
       WHERE user_id = $1 AND device_id = $2`,
      [userId, input.deviceId],
    );
    return 'verificada';
  }

  private encrypt(key: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(encrypted: Buffer): Buffer {
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
  }
}
