import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ROLES, type Role } from '@voxia/shared';
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

import { AuthService } from './auth.service';
import type { AuthenticatedSession } from './auth.types';
import { AUTH_REDIS } from './redis.provider';

/**
 * El token de traspaso vive lo que tarda el WebView en abrirse, no lo que dura
 * una sesion. Viaja en la URL —y por lo tanto queda en el historial del
 * WebView—, asi que el unico control que lo sostiene es que sea de un solo uso
 * y que caduque antes de que alguien alcance a leer esa URL.
 */
export const HANDOFF_TTL_SECONDS = 60;

export interface HandoffClaims {
  userId: string;
  tenantId: string | null;
  role: Role;
  familyId: string;
}

export interface HandoffTicket {
  token: string;
  expiresIn: number;
}

function hashHandoffToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    @Inject(AUTH_REDIS) private readonly redis: Redis,
    private readonly auth: AuthService,
  ) {}

  /**
   * El traspaso no crea acceso nuevo: reparte el que el shell ya tiene. Por eso
   * queda atado a la familia de sesion del llamante y no a su identidad suelta.
   */
  async issue(claims: HandoffClaims): Promise<HandoffTicket> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashHandoffToken(token);

    // En Redis solo entra el hash, igual que los refresh tokens: un volcado de
    // Redis no permite canjear nada. El puntero por familia hace que emitir uno
    // nuevo invalide el anterior, para que un reintento del shell no deje dos
    // credenciales vivas para la misma sesion.
    const issueScript = `
      local previous = redis.call('GET', KEYS[2])
      if previous then redis.call('DEL', 'auth:handoff:' .. previous) end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
      return 1
    `;
    await this.redis.eval(
      issueScript,
      2,
      `auth:handoff:${tokenHash}`,
      `auth:handoff-family:${claims.familyId}`,
      JSON.stringify(claims),
      HANDOFF_TTL_SECONDS,
      tokenHash,
    );

    this.logger.log(
      JSON.stringify({
        event: 'auth_handoff_issued',
        tenant_id: claims.tenantId,
        role: claims.role,
        expires_in: HANDOFF_TTL_SECONDS,
      }),
    );
    return { token, expiresIn: HANDOFF_TTL_SECONDS };
  }

  async redeem(token: string): Promise<AuthenticatedSession> {
    if (this.redis.status === 'wait') await this.redis.connect();

    // GET y DEL en el mismo paso: dos canjes simultaneos no pueden ganar los
    // dos, y el segundo no distingue entre "ya usado" y "nunca existio".
    const consumeScript = `
      local stored = redis.call('GET', KEYS[1])
      if not stored then return '' end
      redis.call('DEL', KEYS[1])
      return stored
    `;
    const stored = (await this.redis.eval(
      consumeScript,
      1,
      `auth:handoff:${hashHandoffToken(token)}`,
    )) as string;

    const claims = stored ? parseClaims(stored) : null;
    if (!claims) {
      this.logger.warn(
        JSON.stringify({ event: 'auth_handoff_rejected', reason: 'usado_vencido_o_desconocido' }),
      );
      throw new UnauthorizedException('El traspaso de sesión no es válido o ya venció');
    }

    const session = await this.auth.issueForExistingSession(claims);
    this.logger.log(
      JSON.stringify({
        event: 'auth_handoff_redeemed',
        tenant_id: claims.tenantId,
        role: claims.role,
      }),
    );
    return session;
  }
}

function parseClaims(serialized: string): HandoffClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { userId, tenantId, role, familyId } = parsed as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof familyId !== 'string') return null;
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) return null;
  // El SUPERADMIN no tiene tenant: null es válido, cualquier otra cosa no.
  if (tenantId !== null && typeof tenantId !== 'string') return null;
  const tenant: string | null = typeof tenantId === 'string' ? tenantId : null;

  return { userId, tenantId: tenant, role: role as Role, familyId };
}
