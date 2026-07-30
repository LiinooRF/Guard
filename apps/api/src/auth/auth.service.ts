import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ROLES, type Role } from '@voxia/shared';
import { verify } from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import type { LoginDto } from './dto/login.dto';
import type {
  AuthenticatedSession,
  AuthIdentityRow,
  LoginResult,
} from './auth.types';
import { AUTH_REDIS } from './redis.provider';

// Hash Argon2id válido de una contraseña aleatoria que nunca se acepta.
// Obliga a ejecutar el mismo trabajo costoso cuando la identidad no existe.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$eqtH1eJxD2FbVVd3DgQVXg$IRTC4hC6I+G4VZcmWvPr0j5oN9UrRkLphD3k+TUn5Gs';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

interface RefreshSession {
  familyId: string;
  userId: string;
  tenantId: string | null;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async login(input: LoginDto, sourceIp = 'unknown'): Promise<LoginResult> {
    const rateLimitKey = await this.checkLoginRateLimit(input.identity, sourceIp);
    const rows = await this.lookupIdentity(input.identity);
    const passwordHash = rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordIsValid = await verify(passwordHash, input.password).catch(() => false);

    if (!passwordIsValid || rows.length === 0) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    await this.redis.del(rateLimitKey);

    const activeRows = rows.filter(
      (row) => row.is_platform_role || row.tenant_status === 'active',
    );
    if (activeRows.length === 0) {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message: 'Tu organización está suspendida. Contacta al administrador de la plataforma.',
      });
    }

    const selected = this.selectMembership(activeRows, input.tenantId);
    if (!selected) {
      return {
        requiresTenantSelection: true,
        tenants: activeRows
          .filter(
            (row): row is AuthIdentityRow & { tenant_id: string; tenant_name: string } =>
              !row.is_platform_role && Boolean(row.tenant_id && row.tenant_name),
          )
          .map((row) => ({
            tenantId: row.tenant_id,
            tenantName: row.tenant_name,
            role: row.role_key,
          })),
      };
    }

    return this.createSession(selected);
  }

  private async checkLoginRateLimit(identity: string, sourceIp: string): Promise<string> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const ipHash = createHash('sha256').update(sourceIp).digest('hex');
    const identityKey = `auth:limit:identity:${identityHash}:${ipHash}`;
    const ipKey = `auth:limit:ip:${ipHash}`;
    const script = `
      local identity_count = redis.call('INCR', KEYS[1])
      local ip_count = redis.call('INCR', KEYS[2])
      if identity_count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      if ip_count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
      return { identity_count, ip_count }
    `;
    const counts = (await this.redis.eval(
      script,
      2,
      identityKey,
      ipKey,
      15 * 60,
    )) as [number, number];

    if (Number(counts[0]) > 5 || Number(counts[1]) > 100) {
      throw new HttpException(
        'Demasiados intentos. Espera unos minutos antes de reintentar.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return identityKey;
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    if (this.redis.status === 'wait') await this.redis.connect();
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.redis.del(`auth:refresh:${refreshHash}`);
  }

  async refresh(refreshToken?: string): Promise<AuthenticatedSession> {
    if (!refreshToken) throw new UnauthorizedException('Sesión inválida o expirada');
    if (this.redis.status === 'wait') await this.redis.connect();

    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    const serialized = await this.redis.getdel(`auth:refresh:${refreshHash}`);
    if (!serialized) throw new UnauthorizedException('Sesión inválida o expirada');

    let stored: RefreshSession;
    try {
      stored = JSON.parse(serialized) as RefreshSession;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
    if (!ROLES.includes(stored.role)) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    return this.rotateSession(stored);
  }

  private async lookupIdentity(identity: string): Promise<AuthIdentityRow[]> {
    const rows = await this.dataSource.query<AuthIdentityRow[]>(
      `SELECT * FROM authenticate_identity($1)`,
      [identity],
    );
    return rows.filter((row) => ROLES.includes(row.role_key));
  }

  private selectMembership(
    rows: AuthIdentityRow[],
    tenantId?: string,
  ): AuthIdentityRow | undefined {
    const platform = rows.find((row) => row.is_platform_role);
    if (platform) return platform;
    if (tenantId) return rows.find((row) => row.tenant_id === tenantId);
    return rows.length === 1 ? rows[0] : undefined;
  }

  private async createSession(identity: AuthIdentityRow): Promise<AuthenticatedSession> {
    // Conecta de forma diferida para que readiness pueda informar Redis caído sin
    // impedir que Nest construya el módulo.
    if (this.redis.status === 'wait') await this.redis.connect();
    const familyId = randomUUID();
    const payload = {
      sub: identity.user_id,
      tenant_id: identity.tenant_id,
      role: identity.role_key satisfies Role,
      sid: familyId,
    };
    return this.issueSession(payload);
  }

  private rotateSession(stored: RefreshSession): Promise<AuthenticatedSession> {
    return this.issueSession({
      sub: stored.userId,
      tenant_id: stored.tenantId,
      role: stored.role,
      sid: stored.familyId,
    });
  }

  private async issueSession(payload: {
    sub: string;
    tenant_id: string | null;
    role: Role;
    sid: string;
  }): Promise<AuthenticatedSession> {
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ACCESS_TTL_SECONDS });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

    await this.redis.set(
      `auth:refresh:${refreshHash}`,
      JSON.stringify({
        familyId: payload.sid,
        userId: payload.sub,
        tenantId: payload.tenant_id,
        role: payload.role,
      }),
      'EX',
      REFRESH_TTL_SECONDS,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: {
        id: payload.sub,
        tenantId: payload.tenant_id,
        tenantName: null,
        role: payload.role,
      },
    };
  }
}
