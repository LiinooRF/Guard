import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { requestLogContext } from './request-context';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

// Rutas que llevan una credencial en el propio path:
//   - el token de traspaso al WebView (#37);
//   - el token de dispositivo del push (#113), que se da de baja con
//     DELETE /push/devices/:token. Quien lo tenga puede mandarle
//     notificaciones a ese telefono, asi que tampoco puede quedar en claro en
//     el log de accesos.
const SECRET_IN_PATH = /^(\/api)?\/(auth\/handoff|push\/devices)\/[^/]+\/?$/;

export function loggedPath(path: string): string {
  return SECRET_IN_PATH.test(path) ? path.replace(/[^/]+\/?$/, ':token') : path;
}

export function requestLogging(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const candidate = request.header('x-request-id');
  const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  const startedAt = performance.now();

  response.setHeader('x-request-id', requestId);
  requestLogContext.run(requestId, () => {
    response.once('finish', () => {
      requestLogContext.setTenant(request.user?.tenant_id ?? null);
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'log',
          event: 'request_completed',
          request_id: requestId,
          tenant_id: request.user?.tenant_id ?? null,
          method: request.method,
          path: loggedPath(request.path),
          status_code: response.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
        })}\n`,
      );
    });
    next();
  });
}
