import { BadRequestException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import type { MailService } from '../auth/mail.service';
import { ProvisioningService } from './provisioning.service';
import type { ProvisionTenantDto } from './dto/provision-tenant.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENTRADA: ProvisionTenantDto = {
  slug: 'andina',
  legalName: 'Seguridad Andina SpA',
  displayName: 'Andina',
  planKey: 'base',
  admin: { email: 'Ana.Rojas@Andina.CL', givenName: 'Ana', familyName: 'Rojas' },
};

const RESULTADO = {
  resultado: { tenant_id: 't-1', admin_user_id: 'u-1', site_id: null },
};

interface Estado {
  revertido: boolean;
}

function fuenteDeDatos(query: jest.Mock, estado: Estado) {
  return {
    transaction: async (operacion: (manager: unknown) => Promise<unknown>) => {
      try {
        return await operacion({ query });
      } catch (error) {
        // Lo que hace TypeORM de verdad: si el callback lanza, rollback.
        estado.revertido = true;
        throw error;
      }
    },
  } as unknown as DataSource;
}

const correoOk = () =>
  ({ invitation: jest.fn().mockResolvedValue({ jobId: 'job-1' }) }) as unknown as MailService;

const consultaOk = () =>
  jest
    .fn()
    .mockResolvedValueOnce([]) // set_config('app.user_id')
    .mockResolvedValueOnce([RESULTADO]);

function servicio(query: jest.Mock, mail: MailService = correoOk()) {
  const estado: Estado = { revertido: false };
  return {
    service: new ProvisioningService(fuenteDeDatos(query, estado), mail),
    estado,
    mail,
  };
}

/**
 * BadRequestException con arreglo de mensajes deja `error.message` en "Bad
 * Request Exception": lo util esta en el cuerpo de la respuesta.
 */
async function capturar(operacion: () => Promise<unknown>): Promise<unknown> {
  try {
    await operacion();
  } catch (error) {
    return error;
  }
  return null;
}

/** Parametros con los que se llamo a platform_provision_tenant. */
function parametrosDelAlta(query: jest.Mock): unknown[] {
  const llamada = query.mock.calls.find(([sql]: [string]) =>
    sql.includes('platform_provision_tenant'),
  );
  return (llamada?.[1] ?? []) as unknown[];
}

describe('ProvisioningService — alta completa (#105)', () => {
  it('crea la empresa y encola la invitacion dentro de la misma transaccion', async () => {
    const query = consultaOk();
    const { service, estado, mail } = servicio(query);

    await expect(service.altaCompleta('super-1', ENTRADA)).resolves.toMatchObject({
      tenantId: 't-1',
      adminUserId: 'u-1',
      siteId: null,
      invitationSent: true,
    });

    expect(estado.revertido).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain(`set_config('app.user_id'`);
    expect(mail.invitation).toHaveBeenCalledTimes(1);
    // El correo se normaliza: el login es citext, pero la invitacion no puede
    // salir a una direccion escrita distinto de como quedo guardada.
    expect((mail.invitation as unknown as jest.Mock).mock.calls[0]?.[0]).toBe('ana.rojas@andina.cl');
  });

  it('la plataforma no conoce la clave del ADMIN: no la pide y no la manda', async () => {
    const query = consultaOk();
    const { service, mail } = servicio(query);
    await service.altaCompleta('super-1', ENTRADA);

    const parametros = parametrosDelAlta(query);
    expect(parametros[8]).toEqual(expect.stringMatching(/^\$argon2id\$/));
    // Lo que viaja a la base es el HASH del token; lo que viaja al correo es el
    // token. Si fueran iguales, quien lea la tabla podria usar la invitacion.
    expect(parametros[11]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    const token = (mail.invitation as unknown as jest.Mock).mock.calls[0]?.[1];
    expect(token).not.toBe(parametros[11]);
    expect(JSON.stringify(ENTRADA)).not.toContain('password');
  });

  it('si la invitacion no se puede encolar, no queda una empresa a medio crear', async () => {
    const query = consultaOk();
    const mail = {
      invitation: jest.fn().mockRejectedValue(new Error('redis caido')),
    } as unknown as MailService;
    const { service, estado } = servicio(query, mail);

    await expect(service.altaCompleta('super-1', ENTRADA)).rejects.toThrow(
      'No fue posible enviar la invitación',
    );
    expect(estado.revertido).toBe(true);
  });

  it('el slug o el correo repetidos son 409, no un 500', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new QueryFailedError('sql', [], { code: '23505' } as unknown as Error),
      );
    const { service, estado } = servicio(query);

    await expect(service.altaCompleta('super-1', ENTRADA)).rejects.toThrow(
      'El slug o el correo ya están registrados',
    );
    expect(estado.revertido).toBe(true);
  });

  it('un plan inexistente es 400 y no un error de base sin traducir', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new QueryFailedError('sql', [], {
          code: '23503',
          constraint: 'tenants_plan_key_fkey',
        } as unknown as Error),
      );
    const { service } = servicio(query);

    await expect(
      service.altaCompleta('super-1', { ...ENTRADA, planKey: 'inventado' }),
    ).rejects.toThrow('El plan indicado no existe');
  });

  it('la reja de la base manda: quien no es SUPERADMIN activo recibe 403', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new QueryFailedError('sql', [], { code: '42501' } as unknown as Error),
      );
    const { service } = servicio(query);

    await expect(service.altaCompleta('super-1', ENTRADA)).rejects.toThrow(
      'Solo un SUPERADMIN activo puede dar de alta empresas',
    );
  });

  it('una regla desconocida aborta antes de tocar la base', async () => {
    const query = consultaOk();
    const { service } = servicio(query);

    const error = await capturar(() =>
      service.altaCompleta('super-1', {
        ...ENTRADA,
        ruleOverrides: { complianceThreshold: 85, umbralInventado: 1 },
      }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: expect.arrayContaining([expect.stringContaining('ruleOverrides')]),
    });
    // Ni siquiera se abrio la transaccion: la configuracion se valida antes.
    expect(query).not.toHaveBeenCalled();
  });

  it('una regla fuera de rango tampoco entra', async () => {
    const query = consultaOk();
    const { service } = servicio(query);

    const error = await capturar(() =>
      service.altaCompleta('super-1', {
        ...ENTRADA,
        ruleOverrides: { complianceThreshold: 140 },
      }),
    );

    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: expect.arrayContaining([
        expect.stringContaining('ruleOverrides.complianceThreshold'),
      ]),
    });
  });

  it('sin overrides la empresa arranca con los defaults de rules.ts, no con copias', async () => {
    const query = consultaOk();
    const { service } = servicio(query);
    await service.altaCompleta('super-1', ENTRADA);

    // '{}' y no los defaults volcados: si mañana cambia un default en
    // rules.ts, cambia tambien para esta empresa.
    expect(parametrosDelAlta(query)[13]).toBe('{}');
  });

  it('los overrides validos viajan como jsonb', async () => {
    const query = consultaOk();
    const { service } = servicio(query);
    await service.altaCompleta('super-1', {
      ...ENTRADA,
      ruleOverrides: { complianceThreshold: 85, randomizeRouteOrder: true },
    });

    expect(JSON.parse(String(parametrosDelAlta(query)[13]))).toEqual({
      complianceThreshold: 85,
      randomizeRouteOrder: true,
    });
  });

  it('sin recinto de ejemplo los cuatro parametros del recinto van nulos', async () => {
    const query = consultaOk();
    const { service } = servicio(query);
    await service.altaCompleta('super-1', ENTRADA);

    expect(parametrosDelAlta(query).slice(14)).toEqual([null, null, null, null]);
  });

  it('con recinto de ejemplo viaja un id generado por la API', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { resultado: { tenant_id: 't-1', admin_user_id: 'u-1', site_id: 's-1' } },
      ]);
    const { service } = servicio(query);

    await expect(
      service.altaCompleta('super-1', {
        ...ENTRADA,
        sampleSite: { branchName: 'Casa Matriz', name: 'Bodega 1', address: 'Av. Siempre Viva 1' },
      }),
    ).resolves.toMatchObject({ siteId: 's-1' });

    const parametros = parametrosDelAlta(query);
    expect(String(parametros[14])).toMatch(UUID);
    expect(parametros.slice(15)).toEqual(['Casa Matriz', 'Bodega 1', 'Av. Siempre Viva 1']);
  });
});
