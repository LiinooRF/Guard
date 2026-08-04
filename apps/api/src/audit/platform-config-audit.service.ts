import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import {
  CONFIG_AREA_LABELS,
  CONFIG_SCOPE_LABELS,
  describeChange,
  type ConfigArea,
  type ConfigScope,
} from './config-audit.catalog';

export interface PlatformConfigAuditFilter {
  readonly area?: ConfigArea;
  readonly paramKey?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

interface TenantChangeRow {
  id: string;
  area: string;
  scope: string;
  target_id: string | null;
  param_key: string;
  old_value: unknown;
  new_value: unknown;
  actor_id: string | null;
  actor_label: string;
  support_access_id: string | null;
  changed_at: Date;
}

interface PlatformChangeRow {
  id: string;
  area: string;
  target_key: string | null;
  param_key: string;
  old_value: unknown;
  new_value: unknown;
  actor_id: string | null;
  actor_label: string;
  changed_at: Date;
}

/**
 * Lado PLATAFORMA del historial de configuracion (#84).
 *
 * Va por DataSource y no por TenantContextService porque el SUPERADMIN no tiene
 * empresa en su sesion: no hay contexto tenant que abrir y RLS le esconderia
 * justo lo que administra. Todo pasa por funciones SECURITY DEFINER que exigen
 * un SUPERADMIN activo dentro de la misma transaccion. El permiso del guard es
 * la primera reja; la funcion es la segunda, y la segunda es la que manda porque
 * no depende de que un decorador este bien puesto.
 *
 * Aca los rangos son instantes ISO y no dias: el SUPERADMIN opera la plataforma
 * completa, donde conviven empresas de husos distintos, y un "dia" comun no
 * existe. Los dias en zona del recinto son del panel del admin.
 */
@Injectable()
export class PlatformConfigAuditService {
  constructor(private readonly dataSource: DataSource) {}

  /** Historial de configuracion de UNA empresa, visto desde la plataforma. */
  async tenantHistory(actorId: string, tenantId: string, filter: PlatformConfigAuditFilter) {
    const rows = await this.consultar<TenantChangeRow>(
      actorId,
      `SELECT id, area, scope, target_id, param_key, old_value, new_value,
              actor_id, actor_label, support_access_id, changed_at
         FROM platform_config_history(
                $1::uuid, $2::uuid, $3::text, $4::text,
                $5::timestamptz, $6::timestamptz, $7::integer
              )`,
      [
        actorId,
        tenantId,
        filter.area ?? null,
        filter.paramKey ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.limit ?? null,
      ],
    );

    return {
      tenantId,
      changes: (rows ?? []).map((row) => {
        const cambio = describeChange(row.area, row.param_key, row.old_value, row.new_value);
        return {
          id: row.id,
          area: row.area,
          areaLabel: CONFIG_AREA_LABELS[row.area as ConfigArea] ?? row.area,
          scope: row.scope,
          scopeLabel: CONFIG_SCOPE_LABELS[row.scope as ConfigScope] ?? row.scope,
          targetId: row.target_id,
          paramKey: row.param_key,
          parameter: cambio.card,
          label: cambio.label,
          oldValue: row.old_value ?? null,
          newValue: row.new_value ?? null,
          oldLabel: cambio.from,
          newLabel: cambio.to,
          summary: cambio.summary,
          actorId: row.actor_id,
          actorLabel: row.actor_label,
          viaSupportAccess: row.support_access_id !== null,
          changedAt: row.changed_at,
        };
      }),
    };
  }

  /**
   * Historial del nivel PLATAFORMA: los defaults que corren para todas las
   * empresas y los modulos que incluye cada plan. Es el cambio con mas alcance
   * del producto y hasta ahora no dejaba rastro en ninguna parte.
   */
  async platformHistory(actorId: string, filter: PlatformConfigAuditFilter) {
    const rows = await this.consultar<PlatformChangeRow>(
      actorId,
      `SELECT id, area, target_key, param_key, old_value, new_value,
              actor_id, actor_label, changed_at
         FROM platform_rules_history(
                $1::uuid, $2::text, $3::text,
                $4::timestamptz, $5::timestamptz, $6::integer
              )`,
      [
        actorId,
        filter.area ?? null,
        filter.paramKey ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.limit ?? null,
      ],
    );

    return {
      changes: (rows ?? []).map((row) => {
        const cambio = describeChange(row.area, row.param_key, row.old_value, row.new_value);
        return {
          id: row.id,
          area: row.area,
          areaLabel: CONFIG_AREA_LABELS[row.area as ConfigArea] ?? row.area,
          // El plan de licencia cuando el cambio es de licencia; null cuando es
          // una regla, que es una sola para todo el producto.
          planKey: row.target_key,
          paramKey: row.param_key,
          parameter: cambio.card,
          label: cambio.label,
          oldValue: row.old_value ?? null,
          newValue: row.new_value ?? null,
          oldLabel: cambio.from,
          newLabel: cambio.to,
          summary: cambio.summary,
          actorId: row.actor_id,
          actorLabel: row.actor_label,
          changedAt: row.changed_at,
        };
      }),
    };
  }

  /**
   * Toda lectura de plataforma declara su actor ANTES de llamar a la funcion.
   *
   * `assert_platform_superadmin` (migracion 1723042800000) no solo comprueba que
   * el actor sea SUPERADMIN activo: ademas exige que sea el MISMO usuario que la
   * conexion declaro en `app.user_id`, con `actor_id IS DISTINCT FROM
   * app_user_id()`. El controlador lleva @SkipTenantContext, asi que el
   * interceptor devuelve sin abrir transaccion ni setear nada: fuera de una
   * transaccion propia `app_user_id()` es NULL, la comparacion da true y la
   * funcion rechaza tambien al SUPERADMIN legitimo — el endpoint entero
   * responderia 403 siempre.
   *
   * El tercer parametro de set_config en `true` es SET LOCAL: el valor muere con
   * la transaccion y no queda pegado a la conexion del pool. Mismo patron que
   * PlatformMetricsService.overview y TenantDataService.withPlatformActor.
   */
  private async consultar<T>(
    actorId: string,
    sql: string,
    parametros: unknown[],
  ): Promise<T[]> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);
        return manager.query<T[]>(sql, parametros);
      });
    } catch (error) {
      // La base es la que decide si el actor puede: si dice que no, eso es un
      // 403 y no un 500. Un 500 aca esconderia un problema de autorizacion real.
      if (error instanceof QueryFailedError && error.driverError?.code === '42501') {
        throw new ForbiddenException(
          'Solo un SUPERADMIN activo puede consultar el historial de configuracion',
        );
      }
      throw error;
    }
  }
}
