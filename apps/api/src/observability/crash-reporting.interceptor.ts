import { HttpException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, throwError, type Observable } from 'rxjs';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { CrashReportingService } from './crash-reporting.service';

/**
 * Manda al proveedor los errores que revientan un endpoint (#27).
 *
 * INTERCEPTOR Y NO ExceptionFilter, y la razon es concreta: un filtro global
 * REEMPLAZA la respuesta de error de toda la API, y la respuesta de error ya es
 * un contrato que consumen la web y la app. Un interceptor observa el error y
 * lo vuelve a lanzar tal cual: si este archivo desapareciera, ninguna respuesta
 * cambiaria. Para algo marcado "opcional" esa es la unica forma honesta de
 * engancharse.
 *
 * SOLO 5xx. Un 400, un 401 y un 403 son el sistema funcionando: alguien mando
 * algo mal o no tenia permiso. Mandarlos convertiria el tablero en ruido y
 * gastaria la cuota del plan gratuito en cosas que no hay que arreglar — que es
 * exactamente lo que el issue pide evitar ("alertar solo lo que amerite").
 *
 * El 404 tiene una trampa propia: `assertEnabled()` responde 404 cuando la
 * empresa no compro un modulo. Si mandaramos los 404, cada vez que alguien
 * abriera una seccion que no contrato tendriamos una alerta de un problema que
 * no existe.
 */
@Injectable()
export class CrashReportingInterceptor implements NestInterceptor {
  constructor(private readonly crash: CrashReportingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Con el driver en 'off' no se engancha nada: ni un pipe de mas por request.
    if (!this.crash.esReportable()) return next.handle();

    return next.handle().pipe(
      catchError((error: unknown) => {
        try {
          if (this.hayQueReportar(error)) {
            const request = context.switchToHttp().getRequest<
              Request & { user?: AuthenticatedUser }
            >();

            // Sin await y sin esperar: el cliente no puede quedar esperando a
            // un tercero para recibir su 500. `void` mas catch: una promesa
            // rechazada sin manejar tumba el proceso en Node.
            void this.crash
              .reportarErrorDeServidor(error, {
                method: request?.method ?? 'UNKNOWN',
                path: request?.path ?? '',
                statusCode: error instanceof HttpException ? error.getStatus() : 500,
                tenantId: request?.user?.tenant_id ?? null,
              })
              .catch(() => undefined);
          }
        } catch {
          // Fallar reportando un error no puede cambiar el error original.
        }

        // Se vuelve a lanzar EL MISMO error: la respuesta no cambia en nada.
        return throwError(() => error);
      }),
    );
  }

  private hayQueReportar(error: unknown): boolean {
    if (!this.crash.esReportable()) return false;
    if (error instanceof HttpException) return error.getStatus() >= 500;
    // Lo que no es HttpException termina en 500: un TypeError, una consulta
    // rota, una promesa rechazada. Eso es justo lo que hay que ver.
    return true;
  }
}
