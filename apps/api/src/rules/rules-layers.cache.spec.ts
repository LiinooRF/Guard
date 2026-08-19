import {
  RULES_CACHE_MAX_ENTRIES,
  RULES_CACHE_TTL_MS,
  RulesLayersCache,
  type CachedRuleLayers,
  type RulesCacheKey,
} from './rules-layers.cache';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const key = (
  tenantId: string,
  siteId: string | null = null,
  checkpointId: string | null = null,
): RulesCacheKey => ({ tenantId, siteId, checkpointId });

const write = (
  cache: RulesLayersCache,
  cacheKey: RulesCacheKey,
  layers: CachedRuleLayers,
): void => {
  expect(
    cache.setIfCurrent(
      cacheKey,
      layers,
      cache.captureGeneration(cacheKey.tenantId),
    ),
  ).toBe(true);
};

describe('RulesLayersCache', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('separa tenant, recinto y punto aunque los demas identificadores coincidan', () => {
    const cache = new RulesLayersCache();

    write(cache, key(TENANT_A), { tenant: { marker: 'tenant-a' } });
    write(cache, key(TENANT_B), { tenant: { marker: 'tenant-b' } });
    write(cache, key(TENANT_A, 'site-1'), { site: { marker: 'site-a' } });
    write(cache, key(TENANT_A, 'site-1', 'checkpoint-1'), {
      checkpoint: { marker: 'checkpoint-a' },
    });

    expect(cache.get(key(TENANT_A))).toEqual({ tenant: { marker: 'tenant-a' } });
    expect(cache.get(key(TENANT_B))).toEqual({ tenant: { marker: 'tenant-b' } });
    expect(cache.get(key(TENANT_A, 'site-1'))).toEqual({ site: { marker: 'site-a' } });
    expect(cache.get(key(TENANT_A, 'site-1', 'checkpoint-1'))).toEqual({
      checkpoint: { marker: 'checkpoint-a' },
    });
  });

  it('expira exactamente dentro del SLA tecnico y contabiliza hit/miss sin IDs', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    const cache = new RulesLayersCache();
    const tenantKey = key(TENANT_A);

    write(cache, tenantKey, { tenant: { marker: 'vigente' } });
    expect(cache.get(tenantKey)).toEqual({ tenant: { marker: 'vigente' } });

    jest.advanceTimersByTime(RULES_CACHE_TTL_MS);
    expect(cache.get(tenantKey)).toBeUndefined();
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 1,
      expirations: 1,
      size: 0,
      ttlMs: 45_000,
    });
    expect(JSON.stringify(cache.stats())).not.toContain(TENANT_A);
  });

  it('invalida un tenant completo sin tocar otro tenant', () => {
    const cache = new RulesLayersCache();
    write(cache, key(TENANT_A), { tenant: { marker: 'a' } });
    write(cache, key(TENANT_A, 'site-a'), { site: { marker: 'a-site' } });
    write(cache, key(TENANT_B), { tenant: { marker: 'b' } });

    cache.invalidateTenant(TENANT_A);

    expect(cache.get(key(TENANT_A))).toBeUndefined();
    expect(cache.get(key(TENANT_A, 'site-a'))).toBeUndefined();
    expect(cache.get(key(TENANT_B))).toEqual({ tenant: { marker: 'b' } });
    expect(cache.stats()).toMatchObject({ invalidations: 1, size: 1 });
  });

  it('una regla de plataforma invalida todos los tenants', () => {
    const cache = new RulesLayersCache();
    write(cache, key(TENANT_A), { platform: { marker: 'old' } });
    write(cache, key(TENANT_B), { platform: { marker: 'old' } });

    cache.invalidateAll();

    expect(cache.get(key(TENANT_A))).toBeUndefined();
    expect(cache.get(key(TENANT_B))).toBeUndefined();
    expect(cache.stats()).toMatchObject({ invalidations: 1, size: 0 });
  });

  it('rechaza un SELECT tenant antiguo que termina despues de la invalidacion', () => {
    const cache = new RulesLayersCache();
    const tenantKey = key(TENANT_A, 'site-a');
    const generationBeforeSelect = cache.captureGeneration(TENANT_A);

    cache.invalidateTenant(TENANT_A);

    expect(
      cache.setIfCurrent(
        tenantKey,
        { tenant: { marker: 'stale-before-commit' } },
        generationBeforeSelect,
      ),
    ).toBe(false);
    expect(cache.get(tenantKey)).toBeUndefined();
    expect(cache.stats()).toMatchObject({ staleWritesRejected: 1, size: 0 });
  });

  it('rechaza una lectura en vuelo cuando cambia la capa plataforma', () => {
    const cache = new RulesLayersCache();
    const tenantKey = key(TENANT_A);
    const generationBeforeSelect = cache.captureGeneration(TENANT_A);

    cache.invalidateAll();

    expect(
      cache.setIfCurrent(
        tenantKey,
        { platform: { marker: 'stale-before-global-commit' } },
        generationBeforeSelect,
      ),
    ).toBe(false);
    expect(cache.get(tenantKey)).toBeUndefined();
    expect(cache.stats()).toMatchObject({ staleWritesRejected: 1, size: 0 });
  });

  it('acota memoria y expulsa la entrada menos recientemente usada', () => {
    const cache = new RulesLayersCache();

    for (let index = 0; index < RULES_CACHE_MAX_ENTRIES; index += 1) {
      write(cache, key(TENANT_A, `site-${index}`), { site: { marker: index } });
    }
    // Mantiene site-0 y vuelve site-1 la menos reciente.
    expect(cache.get(key(TENANT_A, 'site-0'))).toBeDefined();
    write(cache, key(TENANT_A, 'site-extra'), { site: { marker: 'extra' } });

    expect(cache.get(key(TENANT_A, 'site-1'))).toBeUndefined();
    expect(cache.get(key(TENANT_A, 'site-0'))).toBeDefined();
    expect(cache.stats()).toMatchObject({
      evictions: 1,
      size: RULES_CACHE_MAX_ENTRIES,
      maxEntries: RULES_CACHE_MAX_ENTRIES,
    });
  });

  it('devuelve copias para que un consumidor no contamine lecturas futuras', () => {
    const cache = new RulesLayersCache();
    const tenantKey = key(TENANT_A);
    write(cache, tenantKey, { tenant: { nested: ['original'] } });

    const first = cache.get(tenantKey) as { tenant: { nested: string[] } };
    first.tenant.nested.push('mutado');

    expect(cache.get(tenantKey)).toEqual({ tenant: { nested: ['original'] } });
  });
});
