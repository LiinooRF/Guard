import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
  ) {}

  async login(input: LoginDto): Promise<LoginResult> {
    const rows = await this.lookupIdentity(input.identity);
    const passwordHash = rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordIsValid = await verify(passwordHash, input.password).catch(() => false);

    if (!passwordIsValid || rows.length === 0) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const selected = this.selectMembership(rows, input.tenantId);
    if (!selected) {
      return {
        requiresTenantSelection: true,
        tenants: rows
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

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    if (this.redis.status === 'wait') await this.redis.connect();
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.redis.del(`auth:refresh:${refreshHash}`);
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
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    const payload = {
      sub: identity.user_id,
      tenant_id: identity.tenant_id,
      role: identity.role_key satisfies Role,
      sid: familyId,
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ACCESS_TTL_SECONDS });

    await this.redis.set(
      `auth:refresh:${refreshHash}`,
      JSON.stringify({
        familyId,
        userId: identity.user_id,
        tenantId: identity.tenant_id,
        role: identity.role_key,
      }),
      'EX',
      REFRESH_TTL_SECONDS,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: {
        id: identity.user_id,
        tenantId: identity.tenant_id,
        tenantName: identity.tenant_name,
        role: identity.role_key,
      },
    };
  }
}
