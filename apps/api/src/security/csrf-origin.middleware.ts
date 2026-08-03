import { ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Las mutaciones web usan cookies HttpOnly y, por lo tanto, deben probar que
 * nacieron en nuestra propia interfaz. El cliente móvil no depende de cookies
 * ambientales: se identifica explícitamente y usa tokens Bearer.
 */
export function csrfOriginProtection(allowedWebOrigin: string) {
  const expectedOrigin = new URL(allowedWebOrigin).origin;

  return (request: Request, _response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.headers.origin;
    const isNativeRequest =
      !origin &&
      request.headers['x-voxia-client'] === 'mobile' &&
      !request.headers.cookie;

    if (origin === expectedOrigin || isNativeRequest) {
      next();
      return;
    }

    next(new ForbiddenException('Origen de solicitud no permitido'));
  };
}
