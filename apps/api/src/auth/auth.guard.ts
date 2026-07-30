import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { hasPermission, ROLES, type Permission, type Role } from '@voxia/shared';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { IS_PUBLIC } from './decorators/public.decorator';
import { AUTH_REDIS } from './redis.provider';
import { REQUIRED_PERMISSIONS } from './decorators/permissions.decorator';
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
    private readonly dataSource: DataSource,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_PERMISSIONS,
      targets,
    );
    if (!requiredPermissions?.length) {
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

    if (
      !ROLES.includes(payload.role) ||
      !requiredPermissions.every((permission) => hasPermission(payload.role, permission))
    ) {
      this.auditDenied(context, 'permission_forbidden', payload);
      throw new ForbiddenException('No tienes permiso para esta operación');
    }

    if (await this.redis.exists(`auth:revoked-family:${payload.sid}`)) {
      this.auditDenied(context, 'revoked_session', payload);
      throw new UnauthorizedException('La sesión ya no está activa');
    }
    const sessionKey = `auth:session:${payload.sid}`;
    const serializedSession = await this.redis.get(sessionKey);
    if (serializedSession) {
      try {
        const session = JSON.parse(serializedSession) as Record<string, unknown>;
        session.lastUsedAt = new Date().toISOString();
        await this.redis.set(sessionKey, JSON.stringify(session), 'KEEPTTL');
      } catch {
        // Una metadata dañada no concede ni quita acceso; el JWT y la revocación mandan.
      }
    }

    const requiresTenant = this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT, targets);
    if (requiresTenant && !payload.tenant_id) {
      this.auditDenied(context, 'tenant_required', payload);
      throw new ForbiddenException('La operación requiere contexto de empresa');
    }

    if (payload.tenant_id) {
      const rows = await this.dataSource.query<Array<{ active: boolean }>>(
        `SELECT is_active_tenant_session($1, $2, $3) AS active`,
        [payload.sub, payload.tenant_id, payload.role],
      );
      if (!rows[0]?.active) {
        this.auditDenied(context, 'inactive_tenant_session', payload);
        throw new UnauthorizedException('La sesión ya no está activa');
      }
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
