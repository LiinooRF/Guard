import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  resolveRulesWithSource,
  ruleCatalogForScope,
  type PatrolRules,
} from '@sentrycore/shared';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';

import { overridesComoObjeto, sanitizeOverrides } from './rule-overrides';
import { RulesLayersCache } from './rules-layers.cache';

interface PlatformRulesRow {
  overrides: unknown;
  updated_at: Date;
  updated_by: string | null;
}

/**
 * Nivel de PLATAFORMA de la cascada (#80): el default que corre para todas las
 * empresas mientras ninguna lo sobreescriba.
 *
 * Va por DataSource y no por TenantContextService porque el SUPERADMIN no tiene
 * empresa en su sesion — no hay contexto tenant que abrir. Y la escritura pasa
 * por platform_set_rules(), que exige un SUPERADMIN activo dentro de la misma
 * transaccion: el permiso del guard es la primera reja, la funcion es la
 * segunda, y la segunda es la que manda porque no depende de que un decorador
 * este bien puesto.
 */
@Injectable()
export class PlatformRulesService {
  private readonly logger = new Logger(PlatformRulesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cache: RulesLayersCache = new RulesLayersCache(),
  ) {}

  /** Lo que hay hoy en el nivel plataforma, mas el catalogo de lo editable ahi. */
  async view() {
    const rows = await this.dataSource.query<PlatformRulesRow[]>(
      `SELECT overrides, updated_at, updated_by FROM platform_rules WHERE id`,
    );
    return this.vista(rows[0]);
  }

  /**
   * Reemplaza el set COMPLETO de overrides de plataforma. Quitar un campo lo
   * devuelve al default del producto que vive en rules.ts.
   */
  async replace(actorId: string, overrides: Partial<PatrolRules>) {
    try {
      const rows = await this.dataSource.transaction(async (manager: EntityManager) => {
        await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);
        await manager.query(`SELECT platform_set_rules($1, $2::jsonb)`, [
          actorId,
          JSON.stringify(overrides),
        ]);
        return manager.query<PlatformRulesRow[]>(
          `SELECT overrides, updated_at, updated_by FROM platform_rules WHERE id`,
        );
      });
      this.invalidateEffectiveRulesCache();
      return this.vista(rows[0]);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '42501') {
        // El guard ya exigio el permiso; esto es la reja de la base, que es la
        // que manda. Un 500 aca esconderia un problema de autorizacion real.
        throw new ForbiddenException(
          'Solo un SUPERADMIN activo puede cambiar las reglas de la plataforma',
        );
      }
      throw error;
    }
  }

  private invalidateEffectiveRulesCache(): void {
    try {
      this.cache.invalidateAll();
    } catch {
      // La escritura ya fue confirmada por DataSource.transaction. La cache es
      // auxiliar y las replicas convergen por TTL aunque esta invalidacion falle.
      this.logger.warn(
        JSON.stringify({ event: 'rules_cache_failure', operation: 'invalidate_all' }),
      );
    }
  }

  private vista(row: PlatformRulesRow | undefined) {
    const raw = overridesComoObjeto(row?.overrides, 'platform', this.logger);
    const platform = sanitizeOverrides(raw, 'platform', this.logger);
    const { rules, sources } = resolveRulesWithSource({ platform });

    return {
      scope: 'platform' as const,
      effective: rules,
      // Crudos: el SUPERADMIN tiene que ver lo que quedo guardado, invalidos
      // incluidos, para poder corregirlo.
      overrides: raw,
      sources,
      editable: ruleCatalogForScope('platform'),
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  }
}
