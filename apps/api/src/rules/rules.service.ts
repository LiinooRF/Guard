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
import {
  RulesLayersCache,
  type RulesCacheGeneration,
  type RulesCacheKey,
} from './rules-layers.cache';

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
    private readonly cache: RulesLayersCache = new RulesLayersCache(),
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
    return resolveRules(this.sanitizeLayers(await this.readLayers(context, true)));
  }

  /**
   * Lo mismo, pero diciendo de que nivel salio cada valor. Es lo que pide el
   * panel del admin y lo que devuelve el endpoint unico de configuracion
   * efectiva, para que la app no reimplemente la cascada.
   */
  async effectiveWithSource(context: RuleContext = {}) {
    const raw = await this.readLayers(context, true);
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
    this.invalidateCurrentTenantCacheAfterCommit();
    // La transaccion HTTP se confirma despues de que el servicio retorna. No
    // se cachea esta lectura para no publicar un valor aun no confirmado.
    return this.scopeView('tenant', undefined, false);
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
    this.invalidateCurrentTenantCacheAfterCommit();
    return this.scopeView('site', siteId, false);
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
    this.invalidateCurrentTenantCacheAfterCommit();
    return this.scopeView('checkpoint', checkpointId, false);
  }

  /**
   * Efectivas del nivel pedido + lo que ese nivel tiene escrito + el catalogo
   * de lo que ahi se puede editar. Con eso el panel (#83) pinta el formulario
   * sin saber de antemano ni un nombre de campo.
   */
  private async scopeView(scope: RuleScope, targetId?: string, useCache = true) {
    const context: RuleContext =
      scope === 'site'
        ? { siteId: targetId }
        : scope === 'checkpoint'
          ? { checkpointId: targetId }
          : {};

    const raw = await this.readLayers(context, useCache);
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

  private async readLayers(context: RuleContext, useCache: boolean): Promise<RawLayers> {
    const cacheKey = useCache ? this.cacheKey(context) : null;
    let generation: RulesCacheGeneration | undefined;
    if (cacheKey) {
      try {
        // Se captura ANTES del SELECT: una invalidacion post-commit cambia la
        // generacion y setIfCurrent rechaza su resultado aunque termine despues.
        generation = this.cache.captureGeneration(cacheKey.tenantId);
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) return cached;
      } catch {
        this.logCacheFailure('get');
      }
    }

    const rows = await this.tenantContext.manager.query<LayerRow[]>(CASCADE_SQL, [
      context.siteId ?? null,
      context.checkpointId ?? null,
    ]);

    const layers: RawLayers = {};
    for (const row of rows ?? []) {
      if (!row?.scope) continue;
      layers[row.scope] = overridesComoObjeto(row.overrides, row.scope, this.logger);
    }

    if (cacheKey && generation) {
      try {
        this.cache.setIfCurrent(cacheKey, layers, generation);
      } catch {
        // La base respondio correctamente: una cache auxiliar nunca convierte
        // esa lectura en 500 ni sustituye el resultado por defaults.
        this.logCacheFailure('set');
      }
    }
    return layers;
  }

  /**
   * Solo se cachea cuando el tenant viene del contexto autenticado del servidor
   * y esta enlazado al mismo QueryRunner que aplica RLS. Requests normales y el
   * barrido de vencidas lo establecen desde sus fronteras confiables; soporte y
   * cualquier ejecucion sin identidad explicita consultan PostgreSQL.
   */
  private cacheKey(context: RuleContext): RulesCacheKey | null {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) return null;
    return {
      tenantId,
      siteId: context.siteId ?? null,
      checkpointId: context.checkpointId ?? null,
    };
  }

  private invalidateCurrentTenantCacheAfterCommit(): void {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) return;
    try {
      const registered = this.tenantContext.afterCommit(() => {
        try {
          this.cache.invalidateTenant(tenantId);
        } catch {
          // PostgreSQL ya confirmo. La replica converge por TTL aunque falle
          // esta optimizacion y el cliente no recibe un falso error.
          this.logCacheFailure('invalidate_tenant');
        }
      });
      if (!registered) this.logCacheFailure('schedule_invalidate_tenant');
    } catch {
      this.logCacheFailure('schedule_invalidate_tenant');
    }
  }

  private logCacheFailure(
    operation:
      | 'get'
      | 'set'
      | 'invalidate_tenant'
      | 'schedule_invalidate_tenant',
  ): void {
    // Sin clave, tenant ni valores: solo la operacion tecnica que fallo.
    this.logger.warn(JSON.stringify({ event: 'rules_cache_failure', operation }));
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
