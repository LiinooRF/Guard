import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';

import { AuthService } from './auth.service';
import type { MailService } from './mail.service';

const DOS_EMPRESAS = [
  {
    user_id: 'user-guard-1',
    role_key: 'GUARDIA',
    tenant_id: 'tenant-1',
    tenant_name: 'Empresa A',
    tenant_slug: 'empresa-a',
    is_active: true,
    tenant_status: 'active',
  },
  {
    user_id: 'user-guard-1',
    role_key: 'GUARDIA',
    tenant_id: 'tenant-2',
    tenant_name: 'Empresa B',
    tenant_slug: 'empresa-b',
    is_active: true,
    tenant_status: 'active',
  },
];

function crearServicio(query: jest.Mock, redisMock: Partial<Redis> = {}) {
  const ds = {
    query,
  } as unknown as DataSource;

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
    eval: jest.fn().mockImplementation((script: string) => {
      if (script.includes('identity_locked')) return 0;
      return 1;
    }),
    ...redisMock,
  } as unknown as Redis;

  const mail = {} as unknown as MailService;

  return new AuthService(ds, jwt, redis, mail);
}

describe('AuthService · nfcLogin', () => {
  it('rechaza si la tarjeta no coincide con ningún usuario', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const auth = crearServicio(query);

    await expect(auth.nfcLogin({ cardUid: '04A1B2C3D4' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si el usuario encontrado no tiene rol GUARDIA', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        user_id: 'user-admin',
        role_key: 'ADMIN',
        tenant_id: 'tenant-1',
        is_active: true,
        tenant_status: 'active',
      },
    ]);
    const auth = crearServicio(query);

    await expect(auth.nfcLogin({ cardUid: '04A1B2C3D4' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza con ForbiddenException si el tenant está suspendido', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        user_id: 'user-guard',
        role_key: 'GUARDIA',
        tenant_id: 'tenant-1',
        is_active: true,
        tenant_status: 'suspended',
      },
    ]);
    const auth = crearServicio(query);

    await expect(auth.nfcLogin({ cardUid: '04A1B2C3D4' })).rejects.toThrow(
      'Tu organización está suspendida',
    );
  });

  it('inicia sesión exitosamente y emite tokens para un guardia activo', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        {
          user_id: 'user-guard-1',
          email: 'guardia@test.com',
          role_key: 'GUARDIA',
          tenant_id: 'tenant-1',
          tenant_name: 'Seguridad Andina',
          tenant_slug: 'andina',
          is_active: true,
          tenant_status: 'active',
        },
      ])
      .mockResolvedValueOnce([
        { id: 'site-1', name: 'Planta Central', branch_name: 'Norte' },
      ]);

    const auth = crearServicio(query);
    const result = await auth.nfcLogin({ cardUid: '04:A1:B2:C3:D4' });

    expect('user' in result).toBe(true);
    if ('user' in result) {
      expect(result.user.id).toBe('user-guard-1');
      expect(result.user.role).toBe('GUARDIA');
      expect(result.accessToken).toBe('jwt-token-valido');
    }
  });

  it('si pertenece a múltiples tenants sin especificar tenantId, solicita selección', async () => {
    const auth = crearServicio(jest.fn().mockResolvedValue(DOS_EMPRESAS));
    const result = await auth.nfcLogin({ cardUid: '04A1B2C3D4' });

    expect(result).toEqual({
      requiresTenantSelection: true,
      tenants: [
        {
          tenantId: 'tenant-1',
          tenantName: 'Empresa A',
          tenantSlug: 'empresa-a',
          role: 'GUARDIA',
        },
        {
          tenantId: 'tenant-2',
          tenantName: 'Empresa B',
          tenantSlug: 'empresa-b',
          role: 'GUARDIA',
        },
      ],
    });
  });

  /*
   * Lo que hace util al codigo de empresa en la garita: el guardia lo fijo una
   * vez en ese telefono y desde entonces la tarjeta entra sola, aunque su
   * cuenta cuelgue de varias empresas.
   */
  it('con el código de empresa fijado entra directo, sin preguntar cuál', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce(DOS_EMPRESAS)
      .mockResolvedValueOnce([{ id: 'site-1', name: 'Planta Central', branch_name: 'Norte' }]);
    const auth = crearServicio(query);

    const result = await auth.nfcLogin({ cardUid: '04A1B2C3D4', tenantSlug: 'empresa-b' });

    expect('user' in result).toBe(true);
    if ('user' in result) expect(result.user.tenantId).toBe('tenant-2');
  });

  it('un código de empresa ajeno se rechaza sin revelar a qué empresas pertenece', async () => {
    const auth = crearServicio(jest.fn().mockResolvedValue(DOS_EMPRESAS));

    const fallo = await auth
      .nfcLogin({ cardUid: '04A1B2C3D4', tenantSlug: 'empresa-que-no-es-suya' })
      .then(() => null, (error: unknown) => error as ForbiddenException);

    expect(fallo).toBeInstanceOf(ForbiddenException);
    expect(fallo?.getResponse()).toMatchObject({ code: 'TENANT_CODE_MISMATCH' });
    // La lista de empresas del guardia no viaja en el error.
    expect(JSON.stringify(fallo?.getResponse())).not.toContain('Empresa A');
  });
});
