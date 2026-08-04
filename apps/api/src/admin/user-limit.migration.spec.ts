import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(
  __dirname,
  '../database/migrations/1725472820000-EnforceTenantUserLimit.ts',
), 'utf8');

describe('límite de usuarios del plan', () => {
  it('se valida dentro de la función atómica de alta', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION admin_create_tenant_user');
    expect(SQL).toContain('JOIN public.subscription_plans');
    expect(SQL).toContain('current_users >= allowed_users');
  });

  it('bloquea la fila del tenant para impedir carreras entre dos altas', () => {
    expect(SQL).toContain('FOR UPDATE');
    expect(SQL.indexOf('FOR UPDATE')).toBeLessThan(SQL.indexOf('INSERT INTO public.users'));
  });

  it('conserva autorización, rol permitido y reversión', () => {
    expect(SQL).toContain("memberships.role_key = 'ADMIN'");
    expect(SQL).toContain("new_role NOT IN ('SUPERVISOR', 'GUARDIA')");
    expect(SQL).toContain('this.functionSql(false)');
  });
});
