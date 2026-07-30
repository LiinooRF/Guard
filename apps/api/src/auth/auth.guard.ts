import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ROLES, type Role } from '@voxia/shared';
import type { Request } from 'express';

import { IS_PUBLIC } from './decorators/public.decorator';
import { REQUIRED_ROLES } from './decorators/roles.decorator';
import { REQUIRES_TENANT } from './decorators/tenant-scope.decorator';

export interface AuthenticatedUser {
  sub: string;
  tenant_id: string | null;
  role: Role;
  sid: string;
}

interface AuthenticatedRequest extends Request {
  cookies: Record<string, string>;
  user?: AuthenticatedUser;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, targets);
    if (!requiredRoles?.length) {
      this.auditDenied(context, 'missing_authorization_metadata');
      throw new ForbiddenException('Endpoint cerrado por defecto');
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Se requiere autenticación');

    let payload: AuthenticatedUser;
    try {
      payload = await this.jwt.verifyAsync<AuthenticatedUser>(token, {
        algorithms: ['HS256'],
        issuer: 'voxia-api',
        audience: 'voxia-clients',
      });
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    if (!ROLES.includes(payload.role) || !requiredRoles.includes(payload.role)) {
      this.auditDenied(context, 'role_forbidden', payload);
      throw new ForbiddenException('No tienes permiso para esta operación');
    }

    const requiresTenant = this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT, targets);
    if (requiresTenant && !payload.tenant_id) {
      this.auditDenied(context, 'tenant_required', payload);
      throw new ForbiddenException('La operación requiere contexto de empresa');
    }

    request.user = payload;
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | undefined {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
    return request.cookies?.voxia_access;
  }

  private auditDenied(
    context: ExecutionContext,
    reason: string,
    user?: AuthenticatedUser,
  ): void {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.logger.warn(
      JSON.stringify({
        event: 'authorization_denied',
        reason,
        tenant_id: user?.tenant_id ?? null,
        request_id: request.headers['x-request-id'] ?? null,
        method: request.method,
        path: request.path,
      }),
    );
  }
}
