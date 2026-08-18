import type { MigrationInterface, QueryRunner } from 'typeorm';

const TENANT_TABLES = ['sites', 'checkpoints', 'routes', 'route_checkpoints', 'patrols'] as const;

export class CreateDemoDomain1722524400000 implements MigrationInterface {
  name = 'CreateDemoDomain1722524400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // El rol se resuelve de forma unívoca dentro de un tenant.
    await queryRunner.query(
      `CREATE UNIQUE INDEX memberships_tenant_user_unique_idx ON memberships (tenant_id, user_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE sites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_name text NOT NULL,
        name text NOT NULL,
        address text NOT NULL,
        latitude numeric(9,6),
        longitude numeric(9,6),
        timezone text NOT NULL DEFAULT 'America/Santiago',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        CONSTRAINT sites_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT sites_longitude_check CHECK (longitude BETWEEN -180 AND 180)
      )
    `);
    await queryRunner.query(`CREATE INDEX sites_tenant_id_idx ON sites (tenant_id)`);
    await queryRunner.query(`CREATE INDEX sites_branch_idx ON sites (tenant_id, branch_name)`);

    await queryRunner.query(`
      CREATE TABLE checkpoints (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        suggested_order integer NOT NULL DEFAULT 0,
        kind text NOT NULL DEFAULT 'normal'
          CONSTRAINT checkpoints_kind_check CHECK (kind IN ('normal', 'acceso_critico')),
        latitude numeric(9,6),
        longitude numeric(9,6),
        requires_photo boolean,
        instructions text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT checkpoints_latitude_check CHECK (latitude BETWEEN -90 AND 90),
        CONSTRAINT checkpoints_longitude_check CHECK (longitude BETWEEN -180 AND 180)
      )
    `);
    await queryRunner.query(`CREATE INDEX checkpoints_site_idx ON checkpoints (tenant_id, site_id)`);

    await queryRunner.query(`
      CREATE TABLE routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        name text NOT NULL,
        estimated_duration_min integer NOT NULL
          CONSTRAINT routes_duration_check CHECK (estimated_duration_min > 0),
        tolerance_min integer NOT NULL DEFAULT 15
          CONSTRAINT routes_tolerance_check CHECK (tolerance_min >= 0),
        version integer NOT NULL DEFAULT 1,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX routes_site_idx ON routes (tenant_id, site_id)`);

    await queryRunner.query(`
      CREATE TABLE route_checkpoints (
        tenant_id uuid NOT NULL,
        route_id uuid NOT NULL,
        checkpoint_id uuid NOT NULL,
        position integer NOT NULL CONSTRAINT route_checkpoint_position_check CHECK (position > 0),
        is_closing_point boolean NOT NULL DEFAULT false,
        PRIMARY KEY (tenant_id, route_id, position),
        UNIQUE (tenant_id, route_id, checkpoint_id),
        FOREIGN KEY (tenant_id, route_id) REFERENCES routes(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES checkpoints(tenant_id, id) ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX route_single_closing_point_idx
       ON route_checkpoints (tenant_id, route_id) WHERE is_closing_point`,
    );
    await queryRunner.query(
      `CREATE INDEX route_checkpoints_checkpoint_idx ON route_checkpoints (tenant_id, checkpoint_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE patrols (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        route_id uuid NOT NULL,
        guard_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'pendiente'
          CONSTRAINT patrols_status_check
          CHECK (status IN ('pendiente', 'en_curso', 'completada', 'incompleta', 'vencida')),
        scheduled_start_at timestamptz NOT NULL,
        scheduled_end_at timestamptz NOT NULL,
        started_at timestamptz,
        closed_at timestamptz,
        expected_checkpoint_ids jsonb NOT NULL,
        compliance_pct numeric(5,2),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, route_id) REFERENCES routes(tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, guard_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
        CONSTRAINT patrol_window_check CHECK (scheduled_end_at > scheduled_start_at),
        CONSTRAINT patrol_expected_check CHECK (jsonb_typeof(expected_checkpoint_ids) = 'array'),
        CONSTRAINT patrol_compliance_check CHECK (compliance_pct BETWEEN 0 AND 100)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX patrols_schedule_idx ON patrols (tenant_id, scheduled_start_at, status)`,
    );
    await queryRunner.query(`CREATE INDEX patrols_guard_idx ON patrols (tenant_id, guard_id)`);

    for (const table of TENANT_TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_isolation ON ${table}
        FOR ALL
        USING (
          tenant_id = app_tenant_id()
          OR app_has_audited_support_access(tenant_id)
        )
        WITH CHECK (tenant_id = app_tenant_id())
      `);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE
            ON sites, checkpoints, routes, route_checkpoints, patrols
            TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE patrols`);
    await queryRunner.query(`DROP TABLE route_checkpoints`);
    await queryRunner.query(`DROP TABLE routes`);
    await queryRunner.query(`DROP TABLE checkpoints`);
    await queryRunner.query(`DROP TABLE sites`);
    await queryRunner.query(`DROP INDEX memberships_tenant_user_unique_idx`);
  }
}
