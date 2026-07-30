import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ROLES, type Role } from '@voxia/shared';
import { argon2id, hash, verify } from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import type { LoginDto } from './dto/login.dto';
import {
  createAuthActionToken,
  hashAuthActionToken,
  type AuthActionPurpose,
} from './auth-action-token';
import type { CompleteAuthActionDto } from './dto/complete-auth-action.dto';
import { MailService } from './mail.service';
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

interface StoredSession {
  familyId: string;
  userId: string;
  tenantId: string | null;
  role: Role;
  device: string;
  createdAt: string;
  lastUsedAt: string;
}

interface LoginSecurityPolicy {
  maxAttempts: number;
  windowSeconds: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
}

const DEFAULT_LOGIN_POLICY: LoginSecurityPolicy = {
  maxAttempts: 5,
  windowSeconds: 15 * 60,
  baseLockSeconds: 5 * 60,
  maxLockSeconds: 60 * 60,
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    @Inject(AUTH_REDIS) private readonly redis: Redis,
    private readonly mail: MailService,
  ) {}

  async requestPasswordReset(email: string, sourceIp: string): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const identityHash = createHash('sha256').update(email).digest('hex');
    const ipHash = createHash('sha256').update(sourceIp).digest('hex');
    const allowed = await this.redis.eval(
      `
        if redis.call('EXISTS', KEYS[1]) == 1
          or redis.call('EXISTS', KEYS[2]) == 1 then
          return 0
        end
        redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
        redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
        return 1
      `,
      2,
      `auth:password-reset:identity:${identityHash}`,
      `auth:password-reset:ip:${ipHash}`,
      5 * 60,
    );
    if (Number(allowed) !== 1) return;

    const rows = await this.dataSource.query<Array<{
      user_id: string;
      email: string;
      tenant_id: string | null;
    }>>(`SELECT * FROM lookup_recovery_identity($1)`, [email]);
    const identity = rows[0];
    if (!identity) return;

    const action = createAuthActionToken(30 * 60 * 1000);
    try {
      await this.dataSource.query(
        `SELECT issue_auth_action_token($1, $2, 'password_reset', $3, $4)`,
        [identity.user_id, identity.tenant_id, action.tokenHash, action.expiresAt],
      );
      await this.mail.passwordReset(identity.email, action.token);
    } catch {
      this.logger.error(JSON.stringify({ event: 'password_reset_delivery_failed' }));
    }
  }

  completePasswordReset(input: CompleteAuthActionDto): Promise<void> {
    return this.consumeAuthAction(input, 'password_reset');
  }

  completeInvitation(input: CompleteAuthActionDto): Promise<void> {
    return this.consumeAuthAction(input, 'invitation');
  }

  private async consumeAuthAction(
    input: CompleteAuthActionDto,
    purpose: AuthActionPurpose,
  ): Promise<void> {
    const passwordHash = await hash(input.password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    const rows = await this.dataSource.query<Array<{ user_id: string | null }>>(
      `SELECT consume_auth_action_token($1, $2, $3) AS user_id`,
      [hashAuthActionToken(input.token), purpose, passwordHash],
    );
    const userId = rows[0]?.user_id;
    if (!userId) throw new BadRequestException('El enlace no es válido o ya venció');
    await this.revokeAllSessions(userId);
  }

  async login(
    input: LoginDto,
    sourceIp = 'unknown',
    device = 'Dispositivo desconocido',
  ): Promise<LoginResult> {
    const rows = await this.lookupIdentity(input.identity);
    const policy = rows[0]
      ? {
          maxAttempts: rows[0].max_failed_attempts,
          windowSeconds: rows[0].window_seconds,
          baseLockSeconds: rows[0].base_lock_seconds,
          maxLockSeconds: rows[0].max_lock_seconds,
        }
      : DEFAULT_LOGIN_POLICY;
    const identityHash = createHash('sha256').update(input.identity).digest('hex');
    const ipHash = createHash('sha256').update(sourceIp).digest('hex');
    await this.assertLoginNotLocked(identityHash, ipHash);
    const passwordHash = rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordIsValid = await verify(passwordHash, input.password).catch(() => false);

    if (!passwordIsValid || rows.length === 0) {
      const locked = await this.recordFailedLogin(identityHash, ipHash, policy);
      if (locked && rows[0]?.tenant_id) {
        await this.dataSource.query(
          `SELECT record_login_lock($1, $2, $3)`,
          [rows[0].tenant_id, rows[0].user_id, identityHash],
        );
      }
      if (locked) {
        throw new HttpException(
          'Demasiados intentos. Espera antes de volver a intentarlo.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException('Credenciales inválidas');
    }
    await this.clearFailedLogin(identityHash);

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

    return this.createSession(selected, device);
  }

  private async assertLoginNotLocked(identityHash: string, ipHash: string): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const locked = await this.redis.exists(
      `auth:login-lock:identity:${identityHash}`,
      `auth:login-lock:ip:${ipHash}`,
    );
    if (locked) {
      throw new HttpException(
        'Demasiados intentos. Espera antes de volver a intentarlo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordFailedLogin(
    identityHash: string,
    ipHash: string,
    policy: LoginSecurityPolicy,
  ): Promise<boolean> {
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;
    const script = `
      local now = tonumber(ARGV[1])
      local window_start = now - (tonumber(ARGV[2]) * 1000)
      for index = 1, 2 do
        redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', window_start)
        redis.call('ZADD', KEYS[index], now, ARGV[3])
        redis.call('EXPIRE', KEYS[index], ARGV[2])
      end
      local identity_count = redis.call('ZCARD', KEYS[1])
      local ip_count = redis.call('ZCARD', KEYS[2])
      local identity_locked = 0
      if identity_count >= tonumber(ARGV[4]) then
        local level = redis.call('INCR', KEYS[5])
        redis.call('EXPIRE', KEYS[5], ARGV[6])
        local duration = math.min(
          tonumber(ARGV[5]) * math.pow(2, level - 1),
          tonumber(ARGV[6])
        )
        redis.call('SET', KEYS[3], '1', 'EX', math.floor(duration))
        redis.call('DEL', KEYS[1])
        identity_locked = 1
      end
      if ip_count >= tonumber(ARGV[4]) * 10 then
        redis.call('SET', KEYS[4], '1', 'EX', ARGV[5])
        redis.call('DEL', KEYS[2])
      end
      return identity_locked
    `;
    const locked = await this.redis.eval(
      script,
      5,
      `auth:login-attempts:identity:${identityHash}`,
      `auth:login-attempts:ip:${ipHash}`,
      `auth:login-lock:identity:${identityHash}`,
      `auth:login-lock:ip:${ipHash}`,
      `auth:login-lock-level:${identityHash}`,
      now,
      policy.windowSeconds,
      member,
      policy.maxAttempts,
      policy.baseLockSeconds,
      policy.maxLockSeconds,
    );
    return Number(locked) === 1;
  }

  private async clearFailedLogin(identityHash: string): Promise<void> {
    await this.redis.del(
      `auth:login-attempts:identity:${identityHash}`,
      `auth:login-lock-level:${identityHash}`,
    );
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    if (this.redis.status === 'wait') await this.redis.connect();
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    const serialized = await this.redis.get(`auth:refresh:${refreshHash}`);
    if (!serialized) return;
    try {
      const stored = JSON.parse(serialized) as RefreshSession;
      await this.revokeFamily(stored.familyId);
    } catch {
      await this.redis.del(`auth:refresh:${refreshHash}`);
    }
  }

  async refresh(refreshToken?: string): Promise<AuthenticatedSession> {
    if (!refreshToken) throw new UnauthorizedException('Sesión inválida o expirada');
    if (this.redis.status === 'wait') await this.redis.connect();

    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
    const consumeScript = `
      local stored = redis.call('GET', KEYS[1])
      if stored then
        local session = cjson.decode(stored)
        redis.call('DEL', KEYS[1])
        redis.call('SET', KEYS[2], session.familyId, 'EX', ARGV[1])
        return {'valid', stored}
      end
      local reused_family = redis.call('GET', KEYS[2])
      if reused_family then return {'reused', reused_family} end
      return {'missing', ''}
    `;
    const consumed = (await this.redis.eval(
      consumeScript,
      2,
      `auth:refresh:${refreshHash}`,
      `auth:used-refresh:${refreshHash}`,
      REFRESH_TTL_SECONDS,
    )) as ['valid' | 'reused' | 'missing', string];

    if (consumed[0] === 'reused') {
      await this.revokeFamily(consumed[1]);
      this.logger.warn(JSON.stringify({ event: 'refresh_token_reuse', family_revoked: true }));
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
    if (consumed[0] !== 'valid') {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    let stored: RefreshSession;
    try {
      stored = JSON.parse(consumed[1]) as RefreshSession;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
    if (!ROLES.includes(stored.role)) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    const session = await this.getStoredSession(stored.familyId);
    return this.rotateSession(stored, session);
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

  async listSessions(userId: string, currentFamilyId: string) {
    if (this.redis.status === 'wait') await this.redis.connect();
    const familyIds = await this.redis.smembers(`auth:user-sessions:${userId}`);
    if (!familyIds.length) return [];
    const serialized = await this.redis.mget(
      familyIds.map((familyId) => `auth:session:${familyId}`),
    );
    const sessions = serialized.flatMap((value) => {
      if (!value) return [];
      try {
        const session = JSON.parse(value) as StoredSession;
        return [{
          id: session.familyId,
          device: session.device,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          current: session.familyId === currentFamilyId,
        }];
      } catch {
        return [];
      }
    });
    return sessions.toSorted((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  }

  async revokeSession(userId: string, familyId: string): Promise<boolean> {
    const session = await this.getStoredSession(familyId);
    if (!session || session.userId !== userId) return false;
    await this.revokeFamily(familyId);
    return true;
  }

  async revokeAllSessions(userId: string): Promise<number> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const familyIds = await this.redis.smembers(`auth:user-sessions:${userId}`);
    await Promise.all(familyIds.map((familyId) => this.revokeFamily(familyId)));
    return familyIds.length;
  }

  private async createSession(
    identity: AuthIdentityRow,
    device: string,
  ): Promise<AuthenticatedSession> {
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
    const now = new Date().toISOString();
    return this.issueSession(payload, {
      familyId,
      userId: identity.user_id,
      tenantId: identity.tenant_id,
      role: identity.role_key,
      device: device.slice(0, 180),
      createdAt: now,
      lastUsedAt: now,
    });
  }

  private rotateSession(
    stored: RefreshSession,
    session: StoredSession | null,
  ): Promise<AuthenticatedSession> {
    const now = new Date().toISOString();
    return this.issueSession({
      sub: stored.userId,
      tenant_id: stored.tenantId,
      role: stored.role,
      sid: stored.familyId,
    }, session
      ? { ...session, lastUsedAt: now }
      : {
          familyId: stored.familyId,
          userId: stored.userId,
          tenantId: stored.tenantId,
          role: stored.role,
          device: 'Dispositivo desconocido',
          createdAt: now,
          lastUsedAt: now,
        });
  }

  private async issueSession(payload: {
    sub: string;
    tenant_id: string | null;
    role: Role;
    sid: string;
  }, session: StoredSession): Promise<AuthenticatedSession> {
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ACCESS_TTL_SECONDS });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshHash = createHash('sha256').update(refreshToken).digest('hex');

    const serialized = JSON.stringify({
        familyId: payload.sid,
        userId: payload.sub,
        tenantId: payload.tenant_id,
        role: payload.role,
      });
    const familyKey = `auth:family:${payload.sid}`;
    const issueScript = `
      if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      redis.call('SADD', KEYS[2], ARGV[3])
      redis.call('EXPIRE', KEYS[2], ARGV[2])
      redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[2])
      redis.call('SADD', KEYS[5], ARGV[5])
      redis.call('EXPIRE', KEYS[5], ARGV[2])
      return 1
    `;
    const issued = await this.redis.eval(
      issueScript,
      5,
      `auth:refresh:${refreshHash}`,
      familyKey,
      `auth:revoked-family:${payload.sid}`,
      `auth:session:${payload.sid}`,
      `auth:user-sessions:${payload.sub}`,
      serialized,
      REFRESH_TTL_SECONDS,
      refreshHash,
      JSON.stringify(session),
      payload.sid,
    );
    if (Number(issued) !== 1) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

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

  private async revokeFamily(familyId: string): Promise<void> {
    const revokeScript = `
      local hashes = redis.call('SMEMBERS', KEYS[1])
      for _, hash in ipairs(hashes) do
        redis.call('DEL', 'auth:refresh:' .. hash)
      end
      local stored_session = redis.call('GET', KEYS[3])
      if stored_session then
        local session = cjson.decode(stored_session)
        redis.call('SREM', 'auth:user-sessions:' .. session.userId, ARGV[2])
      end
      redis.call('DEL', KEYS[1])
      redis.call('DEL', KEYS[3])
      redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
      return #hashes
    `;
    await this.redis.eval(
      revokeScript,
      3,
      `auth:family:${familyId}`,
      `auth:revoked-family:${familyId}`,
      `auth:session:${familyId}`,
      REFRESH_TTL_SECONDS,
      familyId,
    );
  }

  private async getStoredSession(familyId: string): Promise<StoredSession | null> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const serialized = await this.redis.get(`auth:session:${familyId}`);
    if (!serialized) return null;
    try {
      return JSON.parse(serialized) as StoredSession;
    } catch {
      return null;
    }
  }
}
