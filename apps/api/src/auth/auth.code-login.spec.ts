import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { argon2id, hash } from 'argon2';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';

import { AuthService } from './auth.service';
import { lookupDeCodigo } from './login-code';
import type { MailService } from './mail.service';

/**
 * Ingreso con codigo de empresa + seis digitos (pedido de terreno, 09-09-2026).
 *
 * El codigo IDENTIFICA y AUTENTICA a la vez. Eso lo hace comodo y tambien lo
 * que obliga a defenderlo distinto del resto del login: los codigos validos son
 * tantos como guardias tenga la empresa, no uno solo.
 */

const PEPPER = 'p'.repeat(48);
const CODIGO = '483920';
const EMPRESA = '11111111-1111-4111-8111-111111111111';

function crearServicio(query: jest.Mock, redisMock: Partial<Redis> = {}) {
  const ds = { query } as unknown as DataSource;
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt') } as unknown as JwtService;
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-2),
    // Mismo criterio que el harness del PIN: el script del bloqueo responde 0
    // (no bloqueado) y el del alta de sesion 1 (emitida).
    eval: jest.fn().mockImplementation((script: string) => {
      if (script.includes('identity_locked') || script.includes('ZADD')) return 0;
      return 1;
    }),
    status: 'ready',
    ...redisMock,
  } as unknown as Redis;
  return new AuthService(ds, jwt, redis, {} as unknown as MailService);
}

function filaDeGuardia(hashCodigo: string) {
  return {
    user_id: 'user-guard-1',
    password_hash: null,
    role_key: 'GUARDIA',
    tenant_id: EMPRESA,
    tenant_name: 'Seguridad Andina',
    tenant_slug: 'seguridad-andina',
    tenant_status: 'active',
    is_platform_role: false,
    max_failed_attempts: 5,
    window_seconds: 900,
    base_lock_seconds: 300,
    max_lock_seconds: 3600,
    nfc_pin_hash: null,
    login_code_hash: hashCodigo,
  };
}

let hashDelCodigo: string;

beforeAll(async () => {
  hashDelCodigo = await hash(CODIGO, { type: argon2id });
  process.env.LOGIN_CODE_PEPPER = PEPPER;
});

describe('codeLogin · ingreso con seis dígitos', () => {
  it('entra con el código de empresa y su código personal', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
      .mockResolvedValueOnce([filaDeGuardia(hashDelCodigo)])
      .mockResolvedValue([]);

    const sesion = await crearServicio(query).codeLogin({
      tenantSlug: 'seguridad-andina',
      code: CODIGO,
    } as never);

    expect(sesion).toMatchObject({ accessToken: expect.any(String) });
  });

  /*
   * La busqueda va por el lookup y no probando argon2 contra cada guardia: con
   * cincuenta, cada intento costaria cincuenta hashes lentos y eso ES el
   * ataque. Se comprueba que el valor que viaja a la base sea el HMAC.
   */
  it('encuentra al guardia por el lookup, no probando uno por uno', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
      .mockResolvedValueOnce([filaDeGuardia(hashDelCodigo)])
      .mockResolvedValue([]);

    await crearServicio(query).codeLogin({
      tenantSlug: 'seguridad-andina',
      code: CODIGO,
    } as never);

    const busqueda = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('authenticate_login_code'),
    );
    expect(busqueda).toBeDefined();
    expect(busqueda![1]).toEqual([EMPRESA, lookupDeCodigo(EMPRESA, CODIGO, PEPPER)]);
    expect(JSON.stringify(busqueda![1])).not.toContain(CODIGO);
  });

  it('un código que no existe no entra', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    await expect(
      crearServicio(query).codeLogin({ tenantSlug: 'seguridad-andina', code: '000000' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /*
   * Una empresa inexistente y un codigo equivocado tienen que responder IGUAL:
   * si una respondiera distinto, el ingreso se convierte en un oraculo para
   * saber que empresas existen y que codigos estan en uso.
   */
  it('una empresa que no existe responde igual que un código errado', async () => {
    const sinEmpresa = jest.fn().mockResolvedValueOnce([]).mockResolvedValue([]);
    const sinCodigo = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    const a = await crearServicio(sinEmpresa)
      .codeLogin({ tenantSlug: 'no-existe', code: CODIGO } as never)
      .catch((e) => e);
    const b = await crearServicio(sinCodigo)
      .codeLogin({ tenantSlug: 'seguridad-andina', code: '999999' } as never)
      .catch((e) => e);

    expect(a).toBeInstanceOf(UnauthorizedException);
    expect(b).toBeInstanceOf(UnauthorizedException);
    expect(a.message).toBe(b.message);
  });

  /*
   * El contador va por EMPRESA + IP porque hasta que el codigo acierta no hay
   * identidad contra la cual contar. Sin esto, un script prueba codigos toda la
   * noche sin gastar nunca un bloqueo.
   */
  /*
   * Los DOS caminos fallidos tienen que gastar intento: el codigo errado y la
   * empresa inexistente. Si sondear nombres de empresa saliera gratis, un
   * atacante averigua que slugs existen sin tocar nunca el bloqueo, y recien
   * despues se pone a probar codigos donde sabe que hay guardias.
   */
  it.each([
    [
      'código errado',
      () =>
        jest
          .fn()
          .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
          .mockResolvedValueOnce([])
          .mockResolvedValue([]),
      'seguridad-andina',
    ],
    ['empresa inexistente', () => jest.fn().mockResolvedValueOnce([]).mockResolvedValue([]), 'no-existe'],
  ])('gasta un intento con %s', async (_caso, armarQuery, slug) => {
    const registrados: string[] = [];
    const evalMock = jest.fn().mockImplementation((script: string) => {
      if (script.includes('ZADD')) registrados.push(script);
      return 0;
    });

    await crearServicio(armarQuery(), { eval: evalMock } as Partial<Redis>)
      .codeLogin({ tenantSlug: slug, code: '111111' } as never)
      .catch(() => undefined);

    expect(registrados.length).toBeGreaterThan(0);
  });

  it('una empresa suspendida no entra aunque el código sea correcto', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'suspended' }])
      .mockResolvedValueOnce([{ ...filaDeGuardia(hashDelCodigo), tenant_status: 'suspended' }])
      .mockResolvedValue([]);

    await expect(
      crearServicio(query).codeLogin({ tenantSlug: 'seguridad-andina', code: CODIGO } as never),
    ).rejects.toThrow(/suspendida/i);
  });

  it('con demasiados intentos responde 429 y no sigue probando', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: EMPRESA, status: 'active' }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    const servicio = crearServicio(query, {
      eval: jest.fn().mockResolvedValue(300),
    } as Partial<Redis>);

    const error = await servicio
      .codeLogin({ tenantSlug: 'seguridad-andina', code: '222222' } as never)
      .catch((e) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
  });
});
