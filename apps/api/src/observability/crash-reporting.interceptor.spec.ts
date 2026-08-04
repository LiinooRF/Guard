import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { CrashReportingInterceptor } from './crash-reporting.interceptor';
import type { CrashReportingService } from './crash-reporting.service';

const TENANT = '3f0d8a1c-1111-4222-8333-444455556666';

function contexto(): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        path: '/api/guard/scan',
        user: { sub: 'u1', tenant_id: TENANT, role: 'GUARDIA', sid: 's1' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function crear(enabled = true) {
  const crash = {
    esReportable: () => enabled,
    reportarErrorDeServidor: jest.fn(async () => true),
  } as unknown as CrashReportingService;

  return { crash, interceptor: new CrashReportingInterceptor(crash) };
}

/** Deja correr las promesas sueltas que dispara el interceptor. */
const dejarCorrer = () => new Promise((resolve) => setImmediate(resolve));

describe('CrashReportingInterceptor', () => {
  it('una respuesta correcta pasa igual', async () => {
    const { interceptor } = crear();
    const next = { handle: () => of({ ok: true }) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).resolves.toEqual({
      ok: true,
    });
  });

  it('vuelve a lanzar EXACTAMENTE el mismo error: la respuesta no cambia', async () => {
    const { interceptor } = crear();
    const original = new InternalServerErrorException('se cayo');
    const next = { handle: () => throwError(() => original) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).rejects.toBe(original);
  });

  it.each([
    ['un error sin clase HTTP', new TypeError('undefined no es una funcion')],
    ['un 500', new InternalServerErrorException('x')],
    ['un 503', new ServiceUnavailableException('x')],
  ])('reporta %s', async (_titulo, error) => {
    const { interceptor, crash } = crear();
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).rejects.toBe(error);
    await dejarCorrer();

    expect(crash.reportarErrorDeServidor).toHaveBeenCalledWith(error, {
      method: 'POST',
      path: '/api/guard/scan',
      statusCode: expect.any(Number),
      tenantId: TENANT,
    });
  });

  it.each([
    ['un 400', new BadRequestException('falta un campo')],
    ['un 403', new ForbiddenException('sin permiso')],
    // 404 es tambien lo que responde un modulo que la empresa no contrato:
    // reportarlo llenaria el tablero de problemas que no existen.
    ['un 404', new NotFoundException('no disponible')],
  ])('NO reporta %s: es el sistema funcionando', async (_titulo, error) => {
    const { interceptor, crash } = crear();
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).rejects.toBe(error);
    await dejarCorrer();

    expect(crash.reportarErrorDeServidor).not.toHaveBeenCalled();
  });

  it('con el driver apagado no se engancha ni un pipe', async () => {
    const { interceptor, crash } = crear(false);
    const error = new InternalServerErrorException('x');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).rejects.toBe(error);
    await dejarCorrer();

    expect(crash.reportarErrorDeServidor).not.toHaveBeenCalled();
  });

  it('si el reporte falla, el error original llega igual al cliente', async () => {
    const { interceptor, crash } = crear();
    (crash.reportarErrorDeServidor as jest.Mock).mockRejectedValue(new Error('sentry caido'));
    const original = new InternalServerErrorException('se cayo');
    const next = { handle: () => throwError(() => original) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(contexto(), next))).rejects.toBe(original);
    await dejarCorrer();
  });
});
