import { Injectable } from '@nestjs/common';
import type { RuleScope } from '@voxia/shared';

/**
 * SLA tecnico de propagacion entre replicas.
 *
 * Cada proceso mantiene su propia cache: una escritura invalida inmediatamente
 * la replica que la atendio, mientras que las demas dejan de servir el valor
 * anterior como maximo 45 segundos despues. No se presenta como invalidacion
 * distribuida porque no lo es.
 */
export const RULES_CACHE_TTL_MS = 45_000;

/** Cota de memoria por proceso; la entrada menos usada se expulsa primero. */
export const RULES_CACHE_MAX_ENTRIES = 1_024;

export type CachedRuleLayers = Partial<Record<RuleScope, Record<string, unknown>>>;

export interface RulesCacheKey {
  tenantId: string;
  siteId?: string | null;
  checkpointId?: string | null;
}

export interface RulesCacheStats {
  hits: number;
  misses: number;
  writes: number;
  staleWritesRejected: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  size: number;
  ttlMs: number;
  maxEntries: number;
}

/** Token opaco de una lectura: solo vale mientras no haya una invalidacion. */
export interface RulesCacheGeneration {
  readonly global: number;
  readonly tenant: number;
}

interface CacheEntry {
  tenantId: string;
  expiresAt: number;
  generation: RulesCacheGeneration;
  layers: CachedRuleLayers;
}

/**
 * Cache LRU local de las capas crudas de reglas.
 *
 * Se cachean las capas y no solo el resultado resuelto porque `effective`, la
 * vista con fuentes y las vistas de administracion comparten la misma consulta.
 * Cada lectura devuelve una copia: ningun consumidor puede modificar una
 * entrada y alterar lo que recibira el siguiente request.
 */
@Injectable()
export class RulesLayersCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly tenantGenerations = new Map<string, number>();
  private globalGeneration = 0;
  private readonly counters = {
    hits: 0,
    misses: 0,
    writes: 0,
    staleWritesRejected: 0,
    evictions: 0,
    expirations: 0,
    invalidations: 0,
  };

  get(key: RulesCacheKey): CachedRuleLayers | undefined {
    const serialized = serializeKey(key);
    const entry = this.entries.get(serialized);

    if (!entry) {
      this.counters.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(serialized);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return undefined;
    }
    if (!this.isCurrent(key.tenantId, entry.generation)) {
      this.entries.delete(serialized);
      this.counters.misses += 1;
      return undefined;
    }

    // Map conserva orden de insercion: reinsertar convierte la entrada en la
    // mas recientemente usada y permite una eviction LRU sin otra estructura.
    this.entries.delete(serialized);
    this.entries.set(serialized, entry);
    this.counters.hits += 1;
    return structuredClone(entry.layers);
  }

  /** Captura la generacion ANTES de iniciar el SELECT que llenaria la entrada. */
  captureGeneration(tenantId: string): RulesCacheGeneration {
    return {
      global: this.globalGeneration,
      tenant: this.tenantGenerations.get(tenantId) ?? 0,
    };
  }

  /**
   * Publica el resultado solo si ninguna escritura confirmada invalido su
   * generacion mientras el SELECT estaba en vuelo.
   */
  setIfCurrent(
    key: RulesCacheKey,
    layers: CachedRuleLayers,
    generation: RulesCacheGeneration,
  ): boolean {
    if (!this.isCurrent(key.tenantId, generation)) {
      this.counters.staleWritesRejected += 1;
      return false;
    }

    const serialized = serializeKey(key);
    this.entries.delete(serialized);

    while (this.entries.size >= RULES_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.counters.evictions += 1;
    }

    this.entries.set(serialized, {
      tenantId: key.tenantId,
      expiresAt: Date.now() + RULES_CACHE_TTL_MS,
      generation: { ...generation },
      layers: structuredClone(layers),
    });
    this.counters.writes += 1;
    return true;
  }

  /**
   * Una regla tenant/site/checkpoint puede afectar cualquier contexto de esa
   * empresa, por lo que la invalidacion segura es el tenant completo.
   */
  invalidateTenant(tenantId: string): void {
    this.tenantGenerations.set(
      tenantId,
      (this.tenantGenerations.get(tenantId) ?? 0) + 1,
    );
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === tenantId) this.entries.delete(key);
    }
    this.counters.invalidations += 1;
  }

  /** Una regla de plataforma puede cambiar el efectivo de todos los tenants. */
  invalidateAll(): void {
    this.globalGeneration += 1;
    this.tenantGenerations.clear();
    this.entries.clear();
    this.counters.invalidations += 1;
  }

  /** Contadores agregados, sin claves, IDs ni valores de reglas. */
  stats(): RulesCacheStats {
    return {
      ...this.counters,
      size: this.entries.size,
      ttlMs: RULES_CACHE_TTL_MS,
      maxEntries: RULES_CACHE_MAX_ENTRIES,
    };
  }

  private isCurrent(tenantId: string, generation: RulesCacheGeneration): boolean {
    return (
      generation.global === this.globalGeneration &&
      generation.tenant === (this.tenantGenerations.get(tenantId) ?? 0)
    );
  }
}

function serializeKey(key: RulesCacheKey): string {
  return [key.tenantId, key.siteId ?? '-', key.checkpointId ?? '-'].join('|');
}
