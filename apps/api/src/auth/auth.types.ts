import type { Role } from '@sentrycore/shared';

export interface AuthIdentityRow {
  user_id: string;
  password_hash: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_status: 'active' | 'suspended' | null;
  role_key: Role;
  is_platform_role: boolean;
  max_failed_attempts: number;
  window_seconds: number;
  base_lock_seconds: number;
  max_lock_seconds: number;
  /** Hash argon2id del PIN del login por tarjeta. NULL = ese guardia no usa PIN. */
  nfc_pin_hash: string | null;
  /**
   * Hash del codigo de ingreso del guardia. Lo trae `authenticate_login_code`;
   * `authenticate_identity` no lo devuelve, asi que es opcional.
   */
  login_code_hash?: string | null;
  /** Slug de la empresa. NULL en los roles de plataforma, que no cuelgan de una. */
  tenant_slug: string | null;
}

export interface TenantChoice {
  tenantId: string;
  tenantName: string;
  /** Lo que el guardia deja fijado en su telefono para no volver a elegir. */
  tenantSlug: string;
  role: Role;
}

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    tenantId: string | null;
    tenantName: string | null;
    role: Role;
  };
}

export type LoginResult =
  | AuthenticatedSession
  | {
      requiresTenantSelection: true;
      tenants: TenantChoice[];
    };
