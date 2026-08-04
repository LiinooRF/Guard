import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Hace cumplir el límite del plan dentro de la misma transacción que crea al usuario. */
export class EnforceTenantUserLimit1725472820000 implements MigrationInterface {
  name = 'EnforceTenantUserLimit1725472820000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.functionSql(true));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.functionSql(false));
  }

  private functionSql(enforceLimit: boolean): string {
    const limitGuard = enforceLimit ? `
        -- La fila del tenant serializa altas concurrentes: dos administradores
        -- no pueden observar ambos un cupo libre y exceder el plan a la vez.
        PERFORM 1 FROM public.tenants
        WHERE id = current_tenant_id
        FOR UPDATE;

        SELECT plan.user_limit INTO allowed_users
        FROM public.tenants tenant
        JOIN public.subscription_plans plan ON plan.key = tenant.plan_key
        WHERE tenant.id = current_tenant_id;

        SELECT count(*)::integer INTO current_users
        FROM public.memberships
        WHERE tenant_id = current_tenant_id;

        IF allowed_users IS NULL THEN
          RAISE EXCEPTION 'El plan de la empresa no tiene un límite de usuarios válido'
            USING ERRCODE = 'P0001';
        END IF;
        IF current_users >= allowed_users THEN
          RAISE EXCEPTION 'Límite de usuarios del plan alcanzado (% de %)',
            current_users, allowed_users USING ERRCODE = 'P0001';
        END IF;
    ` : '';

    return `
      CREATE OR REPLACE FUNCTION admin_create_tenant_user(
        new_user_id uuid,
        new_email citext,
        new_username citext,
        new_password_hash text,
        new_given_name text,
        new_family_name text,
        new_role text
      )
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        current_tenant_id uuid := public.app_tenant_id();
        current_actor_id uuid := public.app_user_id();
        allowed_users integer;
        current_users integer;
      BEGIN
        IF current_tenant_id IS NULL OR current_actor_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.memberships
          JOIN public.users ON users.id = memberships.user_id
          WHERE memberships.tenant_id = current_tenant_id
            AND memberships.user_id = current_actor_id
            AND memberships.role_key = 'ADMIN'
            AND users.is_active
        ) THEN
          RAISE EXCEPTION 'tenant admin access denied' USING ERRCODE = '42501';
        END IF;
        IF new_role NOT IN ('SUPERVISOR', 'GUARDIA') THEN
          RAISE EXCEPTION 'invalid managed role' USING ERRCODE = '22023';
        END IF;
        ${limitGuard}
        INSERT INTO public.users (
          id, email, username, password_hash, given_name, family_name
        ) VALUES (
          new_user_id, new_email, new_username, new_password_hash,
          new_given_name, new_family_name
        );
        INSERT INTO public.memberships (tenant_id, user_id, role_key)
        VALUES (current_tenant_id, new_user_id, new_role);
        RETURN new_user_id;
      END
      $$
    `;
  }
}
