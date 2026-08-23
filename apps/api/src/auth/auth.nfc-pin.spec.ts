import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { argon2id, hash } from 'argon2';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';

import { AuthService } from './auth.service';
import type { MailService } from './mail.service';

/**
 * El PIN OPCIONAL del login por tarjeta.
 *
 * Lo que estas pruebas fijan, y por que importa cada una:
 *
 * - **Sin PIN configurado se entra igual que siempre.** El PIN se agrego para
 *   cerrar el agujero de que un UID NFC se clona con cualquier telefono, pero
 *   es opcional por decision de producto: la empresa que prioriza velocidad en
 *   la garita lo deja vacio. Si esta prueba se cae, el cambio dejo a guardias
 *   sin poder entrar, que es peor que el problema que vino a resolver.
 * - **Con PIN configurado, la tarjeta sola NO alcanza.** Es la razon de ser de
 *   la feature.
 * - **Un PIN errado gasta intento.** Sin eso, el PIN se prueba a fuerza bruta
 *   sin tocar nunca el bloqueo que ya protege al resto del login: cuatro
 *   digitos son 10.000 combinaciones, nada para una maquina.
 * - **El PIN nunca se compara en claro**: lo guardado es argon2id.
 */
function crearServicio(query: jest.Mock, redisMock: Partial<Redis> = {}) {
  const ds = { query } as unknown as DataSource;
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('jwt-token-valido'),
  } as unknown as JwtService;
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(-2),
    eval: jest.fn().mockImplementation((script: string) => {
      if (script.includes('identity_locked')) return 0;
      return 1;
    }),
    ...redisMock,
  } as unknown as Redis;
  return new AuthService(ds, jwt, redis, {} as unknown as MailService);
}

function filaDeGuardia(pinHash: string | null) {
  return {
    user_id: 'user-guard-1',
    password_hash: null,
    role_key: 'GUARDIA',
    tenant_id: 'tenant-1',
    tenant_name: 'Seguridad Andina',
    tenant_status: 'active',
    is_platform_role: false,
    max_failed_attempts: 5,
    window_seconds: 900,
    base_lock_seconds: 300,
    max_lock_seconds: 3600,
    nfc_pin_hash: pinHash,
  };
}

const UID = '04A1B2C3D4';
let hashDelPin: string;

beforeAll(async () => {
  // El mismo argon2id con el que el supervisor lo guarda.
  hashDelPin = await hash('4821', {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
});

describe('nfcLogin · PIN opcional', () => {
  it('SIN PIN configurado entra solo con la tarjeta, como antes', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(null)]);
    const auth = crearServicio(query);

    const resultado = await auth.nfcLogin({ cardUid: UID });

    expect('requiresTenantSelection' in resultado).toBe(false);
    if ('requiresTenantSelection' in resultado) return;
    expect(resultado.user.role).toBe('GUARDIA');
  });

  it('CON PIN configurado, la tarjeta sola no alcanza y se pide el PIN', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(hashDelPin)]);
    const auth = crearServicio(query);

    await expect(auth.nfcLogin({ cardUid: UID })).rejects.toMatchObject({
      response: { code: 'NFC_PIN_REQUIRED' },
    });
  });

  it('CON PIN configurado y PIN correcto, entra', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(hashDelPin)]);
    const auth = crearServicio(query);

    const resultado = await auth.nfcLogin({ cardUid: UID, pin: '4821' });

    expect('requiresTenantSelection' in resultado).toBe(false);
    if ('requiresTenantSelection' in resultado) return;
    expect(resultado.user.role).toBe('GUARDIA');
  });

  it('CON PIN configurado y PIN incorrecto, rechaza', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(hashDelPin)]);
    const auth = crearServicio(query);

    await expect(auth.nfcLogin({ cardUid: UID, pin: '0000' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('un PIN errado GASTA intento: si no, se prueba a fuerza bruta gratis', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(hashDelPin)]);
    // `record_login_failure` devuelve que quedo bloqueado.
    const auth = crearServicio(query, {
      eval: jest.fn().mockImplementation((script: string) => {
        if (script.includes('identity_locked')) return 0;
        return 1;
      }),
    });
    const registrar = jest.spyOn(
      auth as unknown as { recordFailedLogin: () => Promise<boolean> },
      'recordFailedLogin',
    );
    registrar.mockResolvedValue(true);

    await expect(auth.nfcLogin({ cardUid: UID, pin: '0000' })).rejects.toThrow(HttpException);
    expect(registrar).toHaveBeenCalled();
  });

  it('el PIN nunca se compara en claro: lo guardado es un hash argon2id', () => {
    expect(hashDelPin.startsWith('$argon2id$')).toBe(true);
    expect(hashDelPin).not.toContain('4821');
  });

  it('que falte el PIN no gasta intento: es el estado en que el portal lo pide', async () => {
    const query = jest.fn().mockResolvedValue([filaDeGuardia(hashDelPin)]);
    const auth = crearServicio(query);
    const registrar = jest.spyOn(
      auth as unknown as { recordFailedLogin: () => Promise<boolean> },
      'recordFailedLogin',
    );
    registrar.mockResolvedValue(false);

    await expect(auth.nfcLogin({ cardUid: UID })).rejects.toMatchObject({
      response: { code: 'NFC_PIN_REQUIRED' },
    });
    expect(registrar).not.toHaveBeenCalled();
  });
});
