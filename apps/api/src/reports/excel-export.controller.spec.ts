import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { ROLES, type Role } from '@sentrycore/shared';

import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard';
import { ExcelExportController } from './excel-export.controller';
import type { ExcelExportService, LibroExportacion } from './excel-export.service';

/**
 * Autorizacion del endpoint nuevo, EN EJECUCION y con los 4 roles.
 *
 * `authorization-matrix.spec.ts` ya declara la fila de este controlador, pero
 * lo hace de forma estatica: deriva los roles de ROLE_PERMISSIONS y compara
 * metadatos. Eso prueba que la tabla y los decoradores coinciden, no que el
 * guard deniegue. Aca corre el AuthGuard de verdad, con un `Reflector` de
 * verdad leyendo los decoradores REALES del controlador: si alguien borra el
 * `@Permissions('reports:read')` o el `@TenantScope()`, esto falla.
 *
 * CLAUDE.md, «Como verificar tu trabajo», punto 3.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';

/** Quien puede pedir la planilla. El resto tiene que recibir 403. */
const ROLES_PERMITIDOS: readonly Role[] = ['ADMIN', 'SUPERVISOR'];

function sesion(role: Role): AuthenticatedUser {
  return {
    sub: 'a0000000-0000-4000-8000-000000000009',
    // El SUPERADMIN no tiene tenant en la sesion: entra por la ventana de
    // soporte auditada (#109), no por los informes de una empresa.
    tenant_id: role === 'SUPERADMIN' ? null : TENANT,
    role,
    sid: 'sesion-de-prueba',
  };
}

/**
 * Contexto apuntando al handler REAL. `getHandler`/`getClass` devuelven el
 * metodo y la clase del controlador, que es de donde el Reflector saca los
 * metadatos que dejaron los decoradores.
 */
function contexto(request: Record<string, unknown> = {}): ExecutionContext {
  Object.assign(request, {
    headers: request.headers ?? {},
    method: 'GET',
    path: '/api/reports/excel',
    cookies: request.cookies ?? { sentrycore_access: 'token' },
  });
  return {
    getClass: () => ExcelExportController,
    getHandler: () => ExcelExportController.prototype.exportarExcel,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardPara(payload: AuthenticatedUser) {
  const jwt = { verifyAsync: jest.fn().mockResolvedValue(payload) } as unknown as JwtService;
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ active: true }]),
  } as unknown as DataSource;
  const redis = {
    exists: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  } as unknown as Redis;
  return new AuthGuard(jwt, new Reflector(), dataSource, redis);
}

describe('autorizacion de GET /reports/excel', () => {
  it.each(ROLES)('%s pasa el guard solo si tiene reports:read y tenant', async (role) => {
    const resultado = guardPara(sesion(role)).canActivate(contexto());

    if (ROLES_PERMITIDOS.includes(role)) {
      await expect(resultado).resolves.toBe(true);
    } else {
      // GUARDIA no tiene reports:read; SUPERADMIN tampoco, y ademas cae por
      // @TenantScope() al no traer tenant_id.
      await expect(resultado).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('sin sesion no entrega la planilla', async () => {
    const guard = guardPara(sesion('ADMIN'));
    await expect(
      guard.canActivate(contexto({ cookies: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un ADMIN sin tenant en la sesion tampoco entra', async () => {
    // El tenant NO viaja por query string: lo pone el interceptor desde la
    // sesion. Sin tenant no hay contexto RLS que abrir.
    const guard = guardPara({ ...sesion('ADMIN'), tenant_id: null });
    await expect(guard.canActivate(contexto())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ExcelExportController.exportarExcel', () => {
  const libro = {
    hojas: [],
    filename: 'exportacion-rondas-20260701-20260731.xlsx',
    colorEncabezado: '#1f3b73',
    colorTextoEncabezado: '#ffffff',
    generadoEn: new Date('2026-08-03T12:00:00Z'),
    conteos: { rondas: 0, escaneos: 0, novedades: 0 },
  } as unknown as LibroExportacion;

  /** Lo mínimo de `express.Response` que toca el controlador. */
  interface RespuestaFalsa {
    status: jest.Mock;
    set: jest.Mock;
    end: jest.Mock;
  }

  const respuesta = () => {
    const cabeceras: Record<string, string> = {};
    const response: RespuestaFalsa = {
      status: jest.fn(() => response),
      set: jest.fn((valores: Record<string, string>) => {
        Object.assign(cabeceras, valores);
        return response;
      }),
      end: jest.fn(),
    };
    return { response, cabeceras };
  };

  const peticion = { user: { sub: 'u-admin', role: 'ADMIN' as const } };

  it('anuncia la descarga con el tipo y el nombre del archivo', async () => {
    const excel = {
      construir: jest.fn().mockResolvedValue(libro),
      escribir: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExcelExportService;
    const { response, cabeceras } = respuesta();

    await new ExcelExportController(excel).exportarExcel(
      {},
      peticion as never,
      response as never,
    );

    expect(cabeceras['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(cabeceras['Content-Disposition']).toContain(libro.filename);
    expect(response.end).toHaveBeenCalled();
  });

  it('si falla la resolucion no escribe ni un byte en la respuesta', async () => {
    // Es la razon de las dos fases: despues del primer byte ya no se puede
    // responder un JSON de error, y el navegador guardaria un .xlsx roto.
    const excel = {
      construir: jest.fn().mockRejectedValue(new ForbiddenException('No es tuyo')),
      escribir: jest.fn(),
    } as unknown as ExcelExportService;
    const { response } = respuesta();

    await expect(
      new ExcelExportController(excel).exportarExcel({}, peticion as never, response as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(response.set).not.toHaveBeenCalled();
    expect(excel.escribir).not.toHaveBeenCalled();
  });
});
