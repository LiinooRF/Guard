import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FeatureFlags } from '@sentrycore/shared';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';

import {
  FEATURE_MODULE_LIST,
  resolveFeatureFlags,
  sanitizeFeatureFlags,
} from './feature-flags.catalog';

interface PlanRow {
  plan_key: string;
  plan_name: string;
  flags: unknown;
  tenant_count: number;
  updated_at: Date | null;
  updated_by: string | null;
}

interface TenantFeaturesRow {
  tenant_id: string;
  display_name: string;
  plan_key: string;
  plan_name: string;
  plan_flags: unknown;
  tenant_grants: unknown;
  tenant_preferences: unknown;
}

/**
 * Lado PLATAFORMA de los feature flags (#82): que incluye cada plan y que se le
 * concede a una empresa puntual.
 *
 * Va por DataSource y no por TenantContextService porque el SUPERADMIN no tiene
 * empresa en su sesion: no hay contexto tenant que abrir, y RLS le esconderia
 * justamente las tablas que administra. Todo pasa por funciones SECURITY
 * DEFINER que exigen un SUPERADMIN activo dentro de la misma transaccion. El
 * permiso del guard es la primera reja; la funcion es la segunda, y la segunda
 * es la que manda porque no depende de que un decorador este bien puesto.
 */
@Injectable()
export class FeatureFlagsPlatformService {
  private readonly logger = new Logger(FeatureFlagsPlatformService.name);

  constructor(private readonly dataSource: DataSource) {}

  /** Que modulos incluye hoy cada plan, con cuantas empresas lo tienen. */
  async plans(actorId: string) {
    const filas = await this.consultar<PlanRow>(
      `SELECT plan_key, plan_name, flags, tenant_count, updated_at, updated_by
       FROM platform_list_plan_features($1)`,
      [actorId],
    );
    return {
      plans: (filas ?? []).map((fila) => this.vistaDePlan(fila)),
      modules: FEATURE_MODULE_LIST,
    };
  }

  /**
   * Reemplaza el set COMPLETO de modulos del plan. Quitar un modulo del body lo
   * devuelve al valor de fabrica del producto, no lo apaga.
   */
  async replacePlanFeatures(actorId: string, planKey: string, flags: Partial<FeatureFlags>) {
    await this.escribir(
      actorId,
      `SELECT platform_set_plan_features($1, $2, $3::jsonb)`,
      [actorId, planKey, JSON.stringify(flags)],
      'El plan no existe',
    );
    this.logger.log(
      JSON.stringify({ event: 'plan_modulos_actualizados', plan: planKey }),
    );
    return this.plans(actorId);
  }

  /** Lo que tiene una empresa concreta: su plan, su concesion y lo que prendio. */
  async tenantFeatures(actorId: string, tenantId: string) {
    const filas = await this.consultar<TenantFeaturesRow>(
      `SELECT tenant_id, display_name, plan_key, plan_name,
              plan_flags, tenant_grants, tenant_preferences
       FROM platform_tenant_features($1, $2)`,
      [actorId, tenantId],
    );
    const fila = filas?.[0];
    if (!fila) throw new NotFoundException('La empresa no existe');
    return this.vistaDeEmpresa(fila);
  }

  /**
   * Reemplaza la concesion de UNA empresa. Es lo que gana por sobre el plan,
   * para el caso real de "se lo damos igual" sin inventar un plan nuevo.
   *
   * Quitar aca un modulo lo apaga al toque para esa empresa aunque el ADMIN lo
   * tenga prendido: el efectivo es un AND, no hace falta ir a limpiar nada.
   */
  async replaceTenantFeatures(actorId: string, tenantId: string, grants: Partial<FeatureFlags>) {
    await this.escribir(
      actorId,
      `SELECT platform_set_tenant_features($1, $2::uuid, $3::jsonb)`,
      [actorId, tenantId, JSON.stringify(grants)],
      'La empresa no existe',
    );
    // Sin nombres de personas ni datos de la empresa: solo el tenant.
    this.logger.log(
      JSON.stringify({ event: 'empresa_modulos_actualizados', tenant_id: tenantId }),
    );
    return this.tenantFeatures(actorId, tenantId);
  }

  private vistaDePlan(fila: PlanRow) {
    const plan = sanitizeFeatureFlags(fila.flags, 'plan', this.logger);
    const resuelto = resolveFeatureFlags({ plan });
    return {
      key: fila.plan_key,
      name: fila.plan_name,
      tenantCount: Number(fila.tenant_count ?? 0),
      // Crudo: el SUPERADMIN tiene que ver lo que quedo guardado, invalidos
      // incluidos, para poder corregirlo.
      flags: fila.flags ?? {},
      includes: resuelto.entitlements,
      sources: resuelto.entitlementSources,
      updatedAt: fila.updated_at ?? null,
      updatedBy: fila.updated_by ?? null,
    };
  }

  private vistaDeEmpresa(fila: TenantFeaturesRow) {
    const resuelto = resolveFeatureFlags({
      plan: sanitizeFeatureFlags(fila.plan_flags, 'plan', this.logger),
      empresa: sanitizeFeatureFlags(fila.tenant_grants, 'empresa', this.logger),
      admin: sanitizeFeatureFlags(fila.tenant_preferences, 'admin', this.logger),
    });

    return {
      tenantId: fila.tenant_id,
      displayName: fila.display_name,
      plan: { key: fila.plan_key, name: fila.plan_name },
      planFlags: fila.plan_flags ?? {},
      grants: fila.tenant_grants ?? {},
      adminPreferences: fila.tenant_preferences ?? {},
      entitlements: resuelto.entitlements,
      entitlementSources: resuelto.entitlementSources,
      enabled: resuelto.enabled,
      sources: resuelto.sources,
      modules: FEATURE_MODULE_LIST,
    };
  }

  private async consultar<T>(sql: string, parametros: unknown[]): Promise<T[]> {
    try {
      return await this.dataSource.query<T[]>(sql, parametros);
    } catch (error) {
      throw this.traducir(error, null);
    }
  }

  private async escribir(
    actorId: string,
    sql: string,
    parametros: unknown[],
    noExiste: string,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);
        await manager.query(sql, parametros);
      });
    } catch (error) {
      throw this.traducir(error, noExiste);
    }
  }

  /**
   * La base es la que decide si el actor puede: si dice que no, eso es un 403 y
   * no un 500. Un 500 aca esconderia un problema de autorizacion real.
   */
  private traducir(error: unknown, noExiste: string | null): Error {
    if (error instanceof QueryFailedError) {
      const codigo = error.driverError?.code;
      if (codigo === '42501') {
        return new ForbiddenException(
          'Solo un SUPERADMIN activo puede cambiar los modulos de un plan o de una empresa',
        );
      }
      // 23503 = violacion de FK: el plan o la empresa que se pidio no existe.
      if (noExiste && codigo === '23503') return new NotFoundException(noExiste);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
