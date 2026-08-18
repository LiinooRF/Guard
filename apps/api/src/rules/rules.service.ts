import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  resolveRules,
  resolveRulesWithSource,
  ruleCatalogForScope,
  type PatrolRules,
  type RuleOverridesByScope,
  type RuleScope,
} from '@sentrycore/shared';
import { QueryFailedError } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { overridesComoObjeto, sanitizeOverrides } from './rule-overrides';

/** Contexto de la consulta: el punto y/o el recinto donde se esta operando. */
export interface RuleContext {
  siteId?: string | null;
  checkpointId?: string | null;
}

type RawLayers = Partial<Record<RuleScope, Record<string, unknown>>>;

interface LayerRow {
  scope: RuleScope;
  overrides: unknown;
}

/**
 * Lee los cuatro niveles de la cascada en UNA consulta (#80).
 *
 * El nivel de recinto se resuelve tambien cuando solo llega el punto: el punto
 * conoce su recinto, y obligar al llamador a mandar los dos seria repartir la
 * cascada entre el servidor y sus clientes, que es justo lo que este issue evita.
 *
 * Sin contexto de recinto ni de punto, esas dos ramas comparan contra NULL y no
 * devuelven filas — falla cerrada, igual que las politicas RLS.
 */
const CASCADE_SQL = `
  SELECT 'platform' AS scope, overrides FROM platform_rules WHERE id
  UNION ALL
  SELECT 'tenant' AS scope, overrides FROM tenant_rules WHERE tenant_id = app_tenant_id()
  UNION ALL
  SELECT 'site' AS scope, overrides FROM site_rules
   WHERE tenant_id = app_tenant_id()
     AND site_id = COALESCE(
       $1::uuid,
       (SELECT site_id FROM checkpoints WHERE tenant_id = app_tenant_id() AND id = $2::uuid)
     )
  UNION ALL
  SELECT 'checkpoint' AS scope, overrides FROM checkpoint_rules
   WHERE tenant_id = app_tenant_id() AND checkpoint_id = $2::uuid
`;

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reglas efectivas para el contexto dado: defaults del producto + plataforma +
   * tenant + recinto + punto, ganando el mas especifico.
   *
   * Sin argumentos devuelve las del tenant, que es lo que necesita el codigo que
   * no tiene un recinto a mano. Un override invalido (escrito por un panel viejo
   * o a mano) se descarta con warning y JAMAS rompe: la operacion en terreno no
   * puede caerse por configuracion.
   */
  async effective(context: RuleContext = {}): Promise<PatrolRules> {
    return resolveRules(this.sanitizeLayers(await this.readLayers(context)));
  }

  /**
   * Lo mismo, pero diciendo de que nivel salio cada valor. Es lo que pide el
   * panel del admin y lo que devuelve el endpoint unico de configuracion
   * efectiva, para que la app no reimplemente la cascada.
   */
  async effectiveWithSource(context: RuleContext = {}) {
    const raw = await this.readLayers(context);
    const layers = this.sanitizeLayers(raw);
    const { rules, sources } = resolveRulesWithSource(layers);
    return {
      context: {
        siteId: context.siteId ?? null,
        checkpointId: context.checkpointId ?? null,
      },
      rules,
      sources,
      layers,
    };
  }

  /**
   * Vista del admin para el nivel tenant: efectivas + overrides crudos tal como
   * estan guardados (con invalidos incluidos, que por eso se muestran: para que
   * el admin vea lo que dejo escrito y lo pueda corregir).
   */
  async adminView() {
    return this.scopeView('tenant');
  }

  /** Vista del admin para el recinto. */
  async siteView(siteId: string) {
    return this.scopeView('site', siteId);
  }

  /** Vista del admin para el punto de control. */
  async checkpointView(checkpointId: string) {
    return this.scopeView('checkpoint', checkpointId);
  }

  /**
   * Reemplaza el set COMPLETO de overrides del tenant (no mergea con lo
   * guardado): quitar un campo del body lo devuelve a su valor heredado.
   */
  async updateOverrides(overrides: Partial<PatrolRules>, actorId: string) {
    await this.tenantContext.manager.query(
      `INSERT INTO tenant_rules (tenant_id, overrides)
       VALUES (app_tenant_id(), $1::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         overrides = EXCLUDED.overrides,
         updated_at = now()`,
      [JSON.stringify(overrides)],
    );
    await this.recordChange(actorId, 'tenant', undefined, overrides);
    return this.adminView();
  }

  /** Idem para un recinto. Configurar uno no toca a los demas del tenant. */
  async updateSiteOverrides(siteId: string, overrides: Partial<PatrolRules>, actorId: string) {
    await this.escribir(
      `INSERT INTO site_rules (tenant_id, site_id, overrides)
       VALUES (app_tenant_id(), $1::uuid, $2::jsonb)
       ON CONFLICT (tenant_id, site_id) DO UPDATE SET
         overrides = EXCLUDED.overrides,
         updated_at = now()`,
      [siteId, JSON.stringify(overrides)],
      'El recinto no existe',
    );
    await this.recordChange(actorId, 'site', siteId, overrides);
    return this.siteView(siteId);
  }

  /** Idem para un punto de control. */
  async updateCheckpointOverrides(
    checkpointId: string,
    overrides: Partial<PatrolRules>,
    actorId: string,
  ) {
    await this.escribir(
      `INSERT INTO checkpoint_rules (tenant_id, checkpoint_id, overrides)
       VALUES (app_tenant_id(), $1::uuid, $2::jsonb)
       ON CONFLICT (tenant_id, checkpoint_id) DO UPDATE SET
         overrides = EXCLUDED.overrides,
         updated_at = now()`,
      [checkpointId, JSON.stringify(overrides)],
      'El punto de control no existe',
    );
    await this.recordChange(actorId, 'checkpoint', checkpointId, overrides);
    return this.checkpointView(checkpointId);
  }

  /**
   * Efectivas del nivel pedido + lo que ese nivel tiene escrito + el catalogo
   * de lo que ahi se puede editar. Con eso el panel (#83) pinta el formulario
   * sin saber de antemano ni un nombre de campo.
   */
  private async scopeView(scope: RuleScope, targetId?: string) {
    const context: RuleContext =
      scope === 'site'
        ? { siteId: targetId }
        : scope === 'checkpoint'
          ? { checkpointId: targetId }
          : {};

    const raw = await this.readLayers(context);
    const layers = this.sanitizeLayers(raw);
    const { rules, sources } = resolveRulesWithSource(layers);

    return {
      scope,
      targetId: targetId ?? null,
      effective: rules,
      // Crudos y sin filtrar: el admin tiene que ver lo que quedo guardado.
      overrides: raw[scope] ?? {},
      sources,
      layers,
      editable: ruleCatalogForScope(scope),
    };
  }

  private async readLayers(context: RuleContext): Promise<RawLayers> {
    const rows = await this.tenantContext.manager.query<LayerRow[]>(CASCADE_SQL, [
      context.siteId ?? null,
      context.checkpointId ?? null,
    ]);

    const layers: RawLayers = {};
    for (const row of rows ?? []) {
      if (!row?.scope) continue;
      layers[row.scope] = overridesComoObjeto(row.overrides, row.scope, this.logger);
    }
    return layers;
  }

  private sanitizeLayers(raw: RawLayers): RuleOverridesByScope {
    const limpio: RuleOverridesByScope = {};
    for (const [scope, overrides] of Object.entries(raw) as Array<
      [RuleScope, Record<string, unknown>]
    >) {
      limpio[scope] = sanitizeOverrides(overrides, scope, this.logger);
    }
    return limpio;
  }

  /**
   * El FK compuesto (tenant_id, id) es lo que garantiza que el recinto o el
   * punto son de ESTE tenant: pedir uno ajeno no da 403 con detalle, da "no
   * existe", que es lo unico que ese tenant tiene derecho a saber.
   */
  private async escribir(sql: string, params: unknown[], noExiste: string) {
    try {
      await this.tenantContext.manager.query(sql, params);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23503') {
        throw new NotFoundException(noExiste);
      }
      throw error;
    }
  }

  private async recordChange(
    actorId: string,
    scope: Exclude<RuleScope, 'platform'>,
    targetId: string | undefined,
    overrides: Partial<PatrolRules>,
  ): Promise<void> {
    const actors = await this.tenantContext.manager.query<Array<{ label: string }>>(
      `SELECT trim(given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
      [actorId],
    );
    const keys = Object.keys(overrides).sort();
    const summary = keys.length
      ? `${scope}: ${keys.length} regla(s) configurada(s): ${keys.join(', ')}`
      : `${scope}: se limpiaron todos los overrides`;
    await this.audit.record({
      actorId,
      actorLabel: actors[0]?.label || 'usuario desconocido',
      action: 'reglas.modificadas',
      entityType: `${scope}_rules`,
      entityId: targetId,
      // Solo nombres de parametros: los valores pueden contener correos u otra PII.
      summary,
    });
  }
}
