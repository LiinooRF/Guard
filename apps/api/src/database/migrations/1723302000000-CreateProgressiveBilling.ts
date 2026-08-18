import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProgressiveBilling1723302000000 implements MigrationInterface {
  name = 'CreateProgressiveBilling1723302000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE billing_tiers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        starts_at_unit integer NOT NULL CHECK (starts_at_unit > 0),
        ends_at_unit integer CHECK (ends_at_unit >= starts_at_unit),
        unit_price_clp integer NOT NULL CHECK (unit_price_clp >= 0),
        effective_from date NOT NULL,
        effective_until date,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_tier_period_check
          CHECK (effective_until IS NULL OR effective_until >= effective_from),
        UNIQUE (starts_at_unit, effective_from)
      )
    `);
    await queryRunner.query(`
      INSERT INTO billing_tiers (
        starts_at_unit, ends_at_unit, unit_price_clp, effective_from
      ) VALUES
        (1, 3, 15000, '2026-07-01'),
        (4, 9, 12000, '2026-07-01'),
        (10, 49, 10000, '2026-07-01'),
        (50, NULL, 8500, '2026-07-01')
    `);

    await queryRunner.query(`
      CREATE FUNCTION calculate_progressive_charge(unit_count integer, billing_date date)
      RETURNS integer
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT COALESCE(sum(
          GREATEST(
            LEAST(unit_count, COALESCE(tier.ends_at_unit, unit_count))
              - tier.starts_at_unit + 1,
            0
          ) * tier.unit_price_clp
        ), 0)::integer
        FROM public.billing_tiers tier
        WHERE tier.effective_from <= billing_date
          AND (tier.effective_until IS NULL OR tier.effective_until >= billing_date)
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION platform_current_billing(actor_id uuid)
      RETURNS TABLE (
        tenant_id uuid,
        display_name text,
        active_site_count integer,
        active_supervisor_count integer,
        billable_unit_count integer,
        net_amount_clp integer,
        billing_month date
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        PERFORM public.assert_platform_superadmin(actor_id);
        RETURN QUERY
        WITH usage AS (
          SELECT
            tenant.id AS tenant_id,
            tenant.display_name,
            (SELECT count(*)::integer FROM public.sites
              WHERE sites.tenant_id = tenant.id AND sites.is_active) AS site_count,
            (
              SELECT count(*)::integer
              FROM public.memberships
              JOIN public.users ON users.id = memberships.user_id
              WHERE memberships.tenant_id = tenant.id
                AND memberships.role_key = 'SUPERVISOR'
                AND users.is_active
            ) AS supervisor_count
          FROM public.tenants tenant
        )
        SELECT
          usage.tenant_id,
          usage.display_name,
          usage.site_count,
          usage.supervisor_count,
          usage.site_count + usage.supervisor_count,
          public.calculate_progressive_charge(
            usage.site_count + usage.supervisor_count,
            current_date
          ),
          date_trunc('month', current_date)::date
        FROM usage
        ORDER BY usage.display_name;
      END
      $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION calculate_progressive_charge(integer, date) FROM PUBLIC`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION platform_current_billing(uuid) FROM PUBLIC`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          GRANT EXECUTE ON FUNCTION platform_current_billing(uuid) TO sentrycore_app;
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION platform_current_billing(uuid)`);
    await queryRunner.query(`DROP FUNCTION calculate_progressive_charge(integer, date)`);
    await queryRunner.query(`DROP TABLE billing_tiers`);
  }
}
