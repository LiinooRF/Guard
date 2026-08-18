import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FeatureFlags } from '@sentrycore/shared';
import { QueryFailedError } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import {
  FEATURE_LEVEL_LABELS,
  FEATURE_MODULE_LIST,
  modulesOutsideLicense,
  resolveFeatureFlags,
  sanitizeFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagLayers,
  type FeatureSourceTable,
} from './feature-flags.catalog';

interface LayerRow {
  nivel: FeatureSourceTable;
  flags: unknown;
  plan_key: string | null;
  plan_name: string | null;
}

/**
 * Los tres niveles guardados, en UNA consulta.
 *
 * Todo cuelga de `app_tenant_id()`: sin contexto de tenant la funcion devuelve
 * NULL, ninguna rama trae filas y la empresa queda con los defaults del
 * producto. Falla cerrada, igual que las politicas RLS.
 *
 * El plan sale de `tenants.plan_key` (columna verificada contra
 * CreateIdentitySchema) y su nombre comercial de `subscription_plans.name`
 * (verificada contra CompleteSuperadminTenantList). El JOIN es seguro porque
 * plan_key es NOT NULL con FK a esa tabla.
 */
const LAYERS_SQL = `
  SELECT 'plan'::text AS nivel,
         coalesce(flags_del_plan.flags, '{}'::jsonb) AS flags,
         tenant.plan_key AS plan_key,
         plan.name AS plan_name
    FROM tenants tenant
    JOIN subscription_plans plan ON plan.key = tenant.plan_key
    LEFT JOIN plan_feature_flags flags_del_plan ON flags_del_plan.plan_key = tenant.plan_key
   WHERE tenant.id = app_tenant_id()
  UNION ALL
  SELECT 'empresa'::text, concesiones.grants, NULL::text, NULL::text
    FROM tenant_feature_grants concesiones
   WHERE concesiones.tenant_id = app_tenant_id()
  UNION ALL
  SELECT 'admin'::text, preferencias.preferences, NULL::text, NULL::text
    FROM tenant_feature_preferences preferencias
   WHERE preferencias.tenant_id = app_tenant_id()
`;

/**
 * Modulos habilitados de la empresa de la sesion (#82).
 *
 * Lo que el resto del backend tiene que usar es `isEnabled()` o
 * `assertEnabled()`. Ninguna decision de "este modulo se ve o no" se resuelve en
 * el navegador: esconder un boton no es control de acceso.
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(private readonly tenantContext: TenantContextService) {}

  /** Modulos efectivos de la empresa actual. */
  async effective(): Promise<FeatureFlags> {
    const { resuelto } = await this.resolver();
    return resuelto.enabled;
  }

  async isEnabled(key: FeatureFlagKey): Promise<boolean> {
    return (await this.effective())[key];
  }

  /**
   * 404 y no 403 a proposito: un modulo que la empresa no tiene DESAPARECE, no
   * queda visible y bloqueado. Un 403 confirmaria que existe y que le falta
   * plata para tenerlo, que es justo lo que el issue pide no hacer.
   */
  async assertEnabled(key: FeatureFlagKey): Promise<void> {
    if (await this.isEnabled(key)) return;
    this.logger.warn(JSON.stringify({ event: 'modulo_apagado_bloqueo', modulo: key }));
    throw new NotFoundException('Esta seccion no esta disponible para tu empresa');
  }

  /**
   * Lo que necesita la app para pintarse: que modulos hay, cuales estan
   * prendidos y por que. Lo pide cualquier rol dentro de la empresa — el guardia
   * necesita saber si tiene libro de novedades tanto como el admin que lo
   * contrata.
   */
  async overview() {
    const { resuelto } = await this.resolver();
    return {
      enabled: resuelto.enabled,
      sources: resuelto.sources,
      modules: FEATURE_MODULE_LIST,
    };
  }

  /**
   * Vista del ADMIN: lo efectivo, el techo de su licencia y SOLO los modulos que
   * puede tocar. Los que su plan no incluye no se listan como editables: si se
   * listaran, la interfaz volveria a mostrar lo que no tiene.
   */
  async adminView() {
    const { resuelto, plan, guardado } = await this.resolver();
    return {
      plan,
      enabled: resuelto.enabled,
      sources: resuelto.sources,
      sourceLabels: FEATURE_LEVEL_LABELS,
      entitlements: resuelto.entitlements,
      entitlementSources: resuelto.entitlementSources,
      // Lo crudo que quedo guardado, para que el admin vea lo que escribio
      // aunque hoy no se aplique (por ejemplo, si le bajaron el plan despues).
      stored: guardado,
      editable: resuelto.editable,
      modules: FEATURE_MODULE_LIST,
    };
  }

  /**
   * Reemplaza el set COMPLETO de preferencias del ADMIN: quitar un modulo del
   * body lo devuelve a su valor de fabrica, igual que en las reglas.
   *
   * Prender un modulo que la licencia no incluye es 403 con el nombre del
   * modulo. Se valida aca ademas de en la base porque el mensaje del servidor es
   * el unico que el jefe de operaciones va a leer; el trigger es la reja que no
   * depende de que este metodo se llame.
   */
  async replacePreferences(preferencias: Partial<FeatureFlags>) {
    const { resuelto } = await this.resolver();

    const fueraDeLicencia = modulesOutsideLicense(preferencias, resuelto.entitlements);
    if (fueraDeLicencia.length) {
      throw new ForbiddenException(
        `El plan contratado no incluye: ${fueraDeLicencia
          .map((modulo) => modulo.label)
          .join(', ')}. Para activarlo hay que cambiar de plan.`,
      );
    }

    try {
      await this.tenantContext.manager.query(
        `INSERT INTO tenant_feature_preferences (tenant_id, preferences)
         VALUES (app_tenant_id(), $1::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           preferences = EXCLUDED.preferences,
           updated_at = now()`,
        [JSON.stringify(preferencias)],
      );
    } catch (error) {
      // 42501 lo levanta el trigger tenant_feature_preferences_license_check.
      // Llega aca solo si el techo cambio entre la lectura y la escritura, o si
      // alguien escribio por otro camino: un 500 lo esconderia.
      if (error instanceof QueryFailedError && error.driverError?.code === '42501') {
        throw new ForbiddenException(
          'El plan contratado no incluye alguno de esos modulos. Vuelve a cargar la pagina.',
        );
      }
      throw error;
    }

    return this.adminView();
  }

  /** Lee los tres niveles guardados y los resuelve contra el catalogo. */
  private async resolver() {
    const filas = await this.tenantContext.manager.query<LayerRow[]>(LAYERS_SQL);

    const capas: FeatureFlagLayers = {};
    let plan: { key: string; name: string } | null = null;
    let guardado: Record<string, unknown> = {};

    for (const fila of filas ?? []) {
      if (!fila?.nivel) continue;
      if (fila.nivel === 'plan' && fila.plan_key) {
        plan = { key: fila.plan_key, name: fila.plan_name ?? fila.plan_key };
      }
      if (fila.nivel === 'admin') {
        guardado =
          fila.flags && typeof fila.flags === 'object' && !Array.isArray(fila.flags)
            ? (fila.flags as Record<string, unknown>)
            : {};
      }
      capas[fila.nivel] = sanitizeFeatureFlags(fila.flags, fila.nivel, this.logger);
    }

    return { resuelto: resolveFeatureFlags(capas), plan, guardado };
  }
}
