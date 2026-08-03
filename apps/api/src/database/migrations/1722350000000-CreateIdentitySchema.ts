import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdentitySchema1722350000000 implements MigrationInterface {
  name = 'CreateIdentitySchema1722350000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);

    await queryRunner.query(`
      CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE,
        legal_name text NOT NULL,
        display_name text NOT NULL,
        status text NOT NULL DEFAULT 'active'
          CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended')),
        plan_key text NOT NULL DEFAULT 'base',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext,
        username citext,
        password_hash text NOT NULL,
        given_name text NOT NULL,
        family_name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_credential_required_check
          CHECK (email IS NOT NULL OR username IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX users_email_unique_idx ON users (email) WHERE email IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX users_username_unique_idx ON users (username) WHERE username IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE roles (
        key text PRIMARY KEY,
        name text NOT NULL,
        scope text NOT NULL CONSTRAINT roles_scope_check CHECK (scope IN ('platform', 'tenant'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE permissions (
        key text PRIMARY KEY,
        description text NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE role_permissions (
        role_key text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
        permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
        PRIMARY KEY (role_key, permission_key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX role_permissions_permission_key_idx ON role_permissions (permission_key)`,
    );

    await queryRunner.query(`
      CREATE TABLE memberships (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_key text NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id, role_key),
        CONSTRAINT memberships_tenant_role_check
          CHECK (role_key IN ('ADMIN', 'SUPERVISOR', 'GUARDIA'))
      )
    `);
    await queryRunner.query(`CREATE INDEX memberships_user_id_idx ON memberships (user_id)`);
    await queryRunner.query(`CREATE INDEX memberships_role_key_idx ON memberships (role_key)`);

    await queryRunner.query(`
      CREATE TABLE platform_memberships (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_key text NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, role_key),
        CONSTRAINT platform_memberships_role_check CHECK (role_key = 'SUPERADMIN')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX platform_memberships_role_key_idx ON platform_memberships (role_key)`,
    );

    await queryRunner.query(`
      INSERT INTO roles (key, name, scope) VALUES
        ('SUPERADMIN', 'Superadministrador de plataforma', 'platform'),
        ('ADMIN', 'Administrador del tenant', 'tenant'),
        ('SUPERVISOR', 'Supervisor de recintos asignados', 'tenant'),
        ('GUARDIA', 'Guardia de turno', 'tenant')
    `);

    await queryRunner.query(`
      INSERT INTO permissions (key, description) VALUES
        ('platform:tenants:manage', 'Administrar empresas cliente'),
        ('platform:metrics:read', 'Consultar metricas globales'),
        ('platform:branding:manage', 'Administrar marca por tenant'),
        ('platform:support:access', 'Solicitar acceso de soporte auditado'),
        ('tenant:users:manage', 'Administrar usuarios del tenant'),
        ('tenant:sites:manage', 'Administrar recintos del tenant'),
        ('tenant:rules:manage', 'Administrar reglas del tenant'),
        ('tenant:stats:read', 'Consultar estadisticas del tenant'),
        ('tenant:audit:read', 'Consultar auditoria del tenant'),
        ('routes:manage', 'Administrar rutas de recintos asignados'),
        ('shifts:manage', 'Administrar turnos de recintos asignados'),
        ('patrols:monitor', 'Monitorear rondas'),
        ('patrols:execute', 'Ejecutar la ronda asignada'),
        ('reports:read', 'Consultar informes autorizados'),
        ('incidents:create', 'Registrar novedades e incidentes')
    `);

    await queryRunner.query(`
      INSERT INTO role_permissions (role_key, permission_key) VALUES
        ('SUPERADMIN', 'platform:tenants:manage'),
        ('SUPERADMIN', 'platform:metrics:read'),
        ('SUPERADMIN', 'platform:branding:manage'),
        ('SUPERADMIN', 'platform:support:access'),
        ('ADMIN', 'tenant:users:manage'),
        ('ADMIN', 'tenant:sites:manage'),
        ('ADMIN', 'tenant:rules:manage'),
        ('ADMIN', 'tenant:stats:read'),
        ('ADMIN', 'tenant:audit:read'),
        ('ADMIN', 'reports:read'),
        ('SUPERVISOR', 'routes:manage'),
        ('SUPERVISOR', 'shifts:manage'),
        ('SUPERVISOR', 'patrols:monitor'),
        ('SUPERVISOR', 'reports:read'),
        ('SUPERVISOR', 'incidents:create'),
        ('GUARDIA', 'patrols:execute'),
        ('GUARDIA', 'incidents:create')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE platform_memberships`);
    await queryRunner.query(`DROP TABLE memberships`);
    await queryRunner.query(`DROP TABLE role_permissions`);
    await queryRunner.query(`DROP TABLE permissions`);
    await queryRunner.query(`DROP TABLE roles`);
    await queryRunner.query(`DROP TABLE users`);
    await queryRunner.query(`DROP TABLE tenants`);
  }
}
