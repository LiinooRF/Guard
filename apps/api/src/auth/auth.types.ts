import type { Role } from '@voxia/shared';

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
}

export interface TenantChoice {
  tenantId: string;
  tenantName: string;
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
