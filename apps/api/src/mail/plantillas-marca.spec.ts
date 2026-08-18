import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { PlantillasMarcaService } from './plantillas-marca';

/**
 * El mock de aca abajo NO valida la consulta: eso se hace contra el texto de
 * las migraciones en plantillas-remitente.migration.spec.ts. Lo que se prueba
 * aca es la CASCADA de nombres y el comportamiento sin contexto de tenant, que
 * son decisiones del codigo y no del esquema.
 */

const CONFIG = {
  get: (_clave: string, porDefecto: string) => porDefecto,
} as unknown as ConfigService;

function servicio(filas: unknown[]): { servicio: PlantillasMarcaService; sql: string[] } {
  const sql: string[] = [];
  const contexto = {
    get manager() {
      return {
        query: (texto: string) => {
          sql.push(texto);
          return Promise.resolve(filas);
        },
      };
    },
  } as unknown as TenantContextService;
  return { servicio: new PlantillasMarcaService(contexto, CONFIG), sql };
}

const TENANT = 'a0000000-0000-4000-8000-000000000001';

function fila(cambios: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    display_name: 'Seguridad Andes SpA',
    legal_name: 'Sociedad de Seguridad Andes Limitada',
    commercial_name: null,
    logo_uri: null,
    primary_color: '#1f3b73',
    mail_from_name: null,
    mail_footer: null,
    reply_to: null,
    from_address: null,
    from_address_verified_at: null,
    ...cambios,
  };
}

describe('PlantillasMarcaService', () => {
  it('prefiere el nombre comercial sobre el de la plataforma y el legal', async () => {
    const { servicio: s } = servicio([fila({ commercial_name: 'Andes Seguridad' })]);
    await expect(s.resolver(200)).resolves.toMatchObject({
      nombreEmpresa: 'Andes Seguridad',
      nombreRemitente: 'Andes Seguridad',
      esDeLaPlataforma: false,
    });
  });

  it('sin nombre comercial usa display_name, y recien despues legal_name', async () => {
    const conDisplay = servicio([fila()]);
    await expect(conDisplay.servicio.resolver(200)).resolves.toMatchObject({
      nombreEmpresa: 'Seguridad Andes SpA',
    });

    const soloLegal = servicio([fila({ display_name: null })]);
    await expect(soloLegal.servicio.resolver(200)).resolves.toMatchObject({
      nombreEmpresa: 'Sociedad de Seguridad Andes Limitada',
    });
  });

  it('el nombre del remitente puede diferir del nombre de la empresa', async () => {
    const { servicio: s } = servicio([
      fila({ commercial_name: 'Andes Seguridad', mail_from_name: 'Avisos Andes' }),
    ]);
    await expect(s.resolver(200)).resolves.toMatchObject({
      nombreEmpresa: 'Andes Seguridad',
      nombreRemitente: 'Avisos Andes',
    });
  });

  it('trata la cadena en blanco como si no hubiera valor', async () => {
    const { servicio: s } = servicio([fila({ commercial_name: '   ', mail_footer: '  ' })]);
    const marca = await s.resolver(200);
    expect(marca.nombreEmpresa).toBe('Seguridad Andes SpA');
    expect(marca.pie).toBeNull();
  });

  it('no entrega la direccion propia mientras no tenga fecha de verificacion', async () => {
    const sinVerificar = servicio([fila({ from_address: 'avisos@andes.cl' })]);
    await expect(sinVerificar.servicio.resolver(200)).resolves.toMatchObject({
      fromAddressVerificada: null,
    });

    const verificada = servicio([
      fila({ from_address: 'avisos@andes.cl', from_address_verified_at: new Date() }),
    ]);
    await expect(verificada.servicio.resolver(200)).resolves.toMatchObject({
      fromAddressVerificada: 'avisos@andes.cl',
    });
  });

  it('calcula el color de texto que contrasta con el color de marca', async () => {
    const oscuro = servicio([fila({ primary_color: '#1f3b73' })]);
    await expect(oscuro.servicio.resolver(200)).resolves.toMatchObject({
      colorTextoSobrePrimario: '#ffffff',
    });

    const claro = servicio([fila({ primary_color: '#ffd700' })]);
    await expect(claro.servicio.resolver(200)).resolves.toMatchObject({
      colorTextoSobrePrimario: '#111111',
    });
  });

  it('sin fila de marca cae a la plataforma en vez de lanzar', async () => {
    const { servicio: s } = servicio([]);
    await expect(s.resolver(200)).resolves.toMatchObject({ esDeLaPlataforma: true });
  });

  it('sin transaccion de tenant devuelve la marca de la plataforma', async () => {
    // Es el caso real del endpoint publico de recuperacion de contraseña, que
    // corre con @SkipTenantContext: sin transaccion no hay RLS ni consulta.
    const contexto = {
      get manager(): never {
        throw new Error('No existe una transaccion asociada al contexto tenant actual');
      },
    } as unknown as TenantContextService;
    const s = new PlantillasMarcaService(contexto, CONFIG);
    const marca = await s.resolver(200);
    expect(marca.esDeLaPlataforma).toBe(true);
    expect(marca.nombreEmpresa).toBe('SentryCore');
  });

  it('nunca consulta la columna inventada tenants.name', async () => {
    const { servicio: s, sql } = servicio([fila()]);
    await s.resolver(200);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/\bt\.name\b/);
    expect(sql[0]).toContain('t.display_name');
    expect(sql[0]).toContain('t.legal_name');
  });

  it('el aviso de logo no incrustable dice DE QUE tenant es, y nada mas', async () => {
    // Sin tenant_id el log no sirve para lo que existe: operaciones veria que
    // algun cliente tiene el logo en un formato no soportado y no podria saber
    // cual. Y no lleva logo_uri ni nombre de empresa (CLAUDE.md, regla 5).
    const { servicio: s } = servicio([
      fila({ logo_uri: 'data:image/webp;base64,UklGRg==' }),
    ]);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await s.resolver(200);
      expect(warn).toHaveBeenCalledTimes(1);
      const registrado = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(registrado).toEqual({
        event: 'correo_sin_logo',
        tenant_id: TENANT,
        motivo: 'formato_no_soportado',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('el logo que si se puede incrustar no deja ningun aviso', async () => {
    const { servicio: s } = servicio([fila({ logo_uri: 'https://andes.cl/logo.png' })]);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await s.resolver(200);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
