import { Injectable, Logger } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';
import type { z } from 'zod';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

/** Validadores campo a campo: un override invalido no arrastra al resto. */
const PARTIAL_RULES_SHAPE: Record<string, z.ZodTypeAny> = patrolRulesSchema.partial().shape;

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Reglas efectivas del tenant actual: defaults del producto + overrides de
   * tenant_rules. Un override invalido (escrito por un panel viejo o a mano)
   * se descarta con warning y JAMAS rompe: la operacion en terreno no puede
   * caerse por configuracion.
   */
  async effective(): Promise<PatrolRules> {
    return patrolRulesSchema.parse(this.sanitize(await this.readOverrides()));
  }

  /** Vista del admin: efectivas + overrides crudos tal como estan guardados. */
  async adminView() {
    const overrides = await this.readOverrides();
    return {
      effective: patrolRulesSchema.parse(this.sanitize(overrides)),
      overrides,
    };
  }

  /**
   * Reemplaza el set COMPLETO de overrides del tenant (no mergea con lo
   * guardado): quitar un campo del body lo devuelve a su default.
   */
  async updateOverrides(overrides: Partial<PatrolRules>) {
    await this.tenantContext.manager.query(
      `INSERT INTO tenant_rules (tenant_id, overrides)
       VALUES (app_tenant_id(), $1::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         overrides = EXCLUDED.overrides,
         updated_at = now()`,
      [JSON.stringify(overrides)],
    );
    return this.adminView();
  }

  private async readOverrides(): Promise<Record<string, unknown>> {
    const rows = await this.tenantContext.manager.query<
      Array<{ overrides: Record<string, unknown> }>
    >(`SELECT overrides FROM tenant_rules WHERE tenant_id = app_tenant_id()`);
    return rows[0]?.overrides ?? {};
  }

  private sanitize(raw: unknown): Partial<PatrolRules> {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      this.logger.warn(JSON.stringify({ event: 'reglas_overrides_no_objeto' }));
      return {};
    }

    const valid: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = PARTIAL_RULES_SHAPE[key];
      if (!field) {
        this.logger.warn(JSON.stringify({ event: 'regla_desconocida_descartada', key }));
        continue;
      }
      const parsed = field.safeParse(value);
      if (!parsed.success) {
        this.logger.warn(JSON.stringify({ event: 'regla_invalida_descartada', key }));
        continue;
      }
      valid[key] = parsed.data;
    }
    return valid as Partial<PatrolRules>;
  }
}
