import {
  DEFAULT_PATROL_RULES,
  isRuleAllowedAtScope,
  patrolRulesSchema,
  PATROL_RULE_CATALOG,
  PATROL_RULE_KEYS,
  PATROL_RULE_LIST,
  pickRulesForScope,
  resolveRules,
  resolveRulesWithSource,
  ruleCatalogForScope,
  ruleKeysForScope,
  RULE_GROUPS,
  RULE_SCOPES,
  RULE_UNITS,
  RULE_VALUE_TYPES,
  type AnyRuleParameter,
  type PatrolRules,
} from '@voxia/shared';
import type { z } from 'zod';

const SHAPE = patrolRulesSchema.shape as Record<string, z.ZodTypeAny>;
const campo = (key: keyof PatrolRules) => SHAPE[key] as z.ZodTypeAny;

describe('catalogo de parametros de ronda (#81)', () => {
  it('describe TODOS los parametros del schema y ninguno de mas', () => {
    expect([...PATROL_RULE_KEYS].sort()).toEqual(Object.keys(DEFAULT_PATROL_RULES).sort());
    expect(PATROL_RULE_LIST).toHaveLength(PATROL_RULE_KEYS.length);
  });

  it.each(PATROL_RULE_LIST)('$key esta descrito en lenguaje del cliente', (parametro) => {
    expect(parametro.label.trim().length).toBeGreaterThan(3);
    expect(parametro.description.trim().length).toBeGreaterThan(20);
    // Nada de nombres de campo ni de tablas en el texto que ve el cliente.
    expect(parametro.description).not.toMatch(/[a-z]+[A-Z]|_id\b|jsonb/);
  });

  it.each(PATROL_RULE_LIST)('$key declara tipo, unidad y niveles validos', (parametro) => {
    expect(RULE_VALUE_TYPES).toContain(parametro.type);
    expect(RULE_GROUPS).toContain(parametro.group);
    if (parametro.unit !== null) expect(RULE_UNITS).toContain(parametro.unit);

    expect(parametro.scopes.length).toBeGreaterThan(0);
    for (const scope of parametro.scopes) expect(RULE_SCOPES).toContain(scope);
    // Declarados de general a especifico, para que la interfaz los pinte en orden.
    const posiciones = parametro.scopes.map((scope) => RULE_SCOPES.indexOf(scope));
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
  });

  it.each(PATROL_RULE_LIST)('$key trae el mismo default que el schema compartido', (parametro) => {
    expect(parametro.default).toEqual(DEFAULT_PATROL_RULES[parametro.key]);
  });

  /**
   * El rango del catalogo es lo que la interfaz usa para el control; si se
   * desviara del que valida zod, el admin veria un limite y la API le
   * respondaria otro.
   */
  it.each(PATROL_RULE_LIST.filter((parametro) => parametro.type === 'integer'))(
    '$key acepta exactamente el rango que declara',
    (parametro: AnyRuleParameter) => {
      const { min, max } = parametro;
      expect(typeof min).toBe('number');
      expect(typeof max).toBe('number');

      const validador = campo(parametro.key);
      expect(validador.safeParse(min).success).toBe(true);
      expect(validador.safeParse(max).success).toBe(true);
      expect(validador.safeParse((min as number) - 1).success).toBe(false);
      expect(validador.safeParse((max as number) + 1).success).toBe(false);
      expect(validador.safeParse(1.5).success).toBe(false);
    },
  );

  it.each(PATROL_RULE_LIST.filter((parametro) => parametro.type === 'boolean'))(
    '$key es si/no de verdad',
    (parametro: AnyRuleParameter) => {
      expect(campo(parametro.key).safeParse(true).success).toBe(true);
      expect(campo(parametro.key).safeParse('si').success).toBe(false);
    },
  );

  it.each(PATROL_RULE_LIST.filter((parametro) => parametro.type === 'multi-select'))(
    '$key ofrece opciones que el schema acepta',
    (parametro: AnyRuleParameter) => {
      expect(parametro.options?.length).toBeGreaterThan(0);
      expect(campo(parametro.key).safeParse(parametro.options).success).toBe(true);
      expect(campo(parametro.key).safeParse(['inventada']).success).toBe(false);
    },
  );

  it.each(PATROL_RULE_LIST.filter((parametro) => parametro.type === 'email-list'))(
    '$key acepta hasta maxItems correos y rechaza lo que no es correo',
    (parametro: AnyRuleParameter) => {
      const tope = parametro.maxItems as number;
      expect(tope).toBeGreaterThan(0);
      const correos = Array.from({ length: tope }, (_, i) => `persona${i}@empresa.cl`);
      expect(campo(parametro.key).safeParse(correos).success).toBe(true);
      expect(campo(parametro.key).safeParse([...correos, 'otro@empresa.cl']).success).toBe(false);
      expect(campo(parametro.key).safeParse(['no-es-un-correo']).success).toBe(false);
    },
  );

  it('cubre los 12 parametros que pide el issue', () => {
    // business_hours es por recinto y vive en site_business_hours (#13); en el
    // catalogo esta el unico parametro configurable asociado: que se asume
    // mientras ese horario no existe.
    for (const key of [
      'complianceThreshold',
      'businessHoursDefaultOpen',
      'photoRequiredOutsideHours',
      'photoRequiredOnCritical',
      'gpsSharingMandatory',
      'gpsValidationRadiusM',
      'randomizeRouteOrder',
      'autoSendReportOnClose',
      'allowQrFallback',
      'maxPatrolDurationMin',
      'reportRecipients',
      'photoRetentionDays',
    ] as Array<keyof PatrolRules>) {
      expect(PATROL_RULE_CATALOG[key]).toBeDefined();
    }
  });

  it('no deja fijar destinatarios de informe a nivel plataforma', () => {
    // Un destinatario global recibiria los informes de TODAS las empresas del
    // SaaS: eso es una fuga cruzada, no una comodidad.
    expect(isRuleAllowedAtScope('reportRecipients', 'platform')).toBe(false);
    expect(isRuleAllowedAtScope('reportRecipients', 'tenant')).toBe(true);
  });

  it('mantiene la retencion y el bloqueo de cuenta como politica de la empresa', () => {
    for (const key of ['photoRetentionDays', 'gpsTrackRetentionDays', 'maxLoginAttempts'] as Array<
      keyof PatrolRules
    >) {
      expect(isRuleAllowedAtScope(key, 'site')).toBe(false);
      expect(isRuleAllowedAtScope(key, 'checkpoint')).toBe(false);
    }
  });
});

describe('filtros por nivel de la cascada', () => {
  it('ruleKeysForScope y ruleCatalogForScope dicen lo mismo', () => {
    for (const scope of RULE_SCOPES) {
      expect(ruleCatalogForScope(scope).map((parametro) => parametro.key)).toEqual(
        ruleKeysForScope(scope),
      );
      expect(ruleKeysForScope(scope).length).toBeGreaterThan(0);
    }
  });

  it('pickRulesForScope descarta lo que ese nivel no puede configurar', () => {
    expect(
      pickRulesForScope('checkpoint', {
        gpsValidationRadiusM: 120,
        photoRetentionDays: 30,
      }),
    ).toEqual({ gpsValidationRadiusM: 120 });
  });

  it('el nivel tenant puede configurar todo lo que puede el recinto y el punto', () => {
    const tenant = new Set(ruleKeysForScope('tenant'));
    for (const scope of ['site', 'checkpoint'] as const) {
      for (const key of ruleKeysForScope(scope)) expect(tenant.has(key)).toBe(true);
    }
  });
});

describe('resolucion de la cascada', () => {
  it('gana el mas especifico y resolveRules sigue devolviendo solo las reglas', () => {
    const efectivas = resolveRules({
      platform: { complianceThreshold: 60 },
      tenant: { complianceThreshold: 85, gpsValidationRadiusM: 30 },
      site: { complianceThreshold: 90 },
    });

    expect(efectivas.complianceThreshold).toBe(90);
    expect(efectivas.gpsValidationRadiusM).toBe(30);
    expect(efectivas.photoRetentionDays).toBe(DEFAULT_PATROL_RULES.photoRetentionDays);
  });

  it('sin ningun override el resultado son los defaults completos', () => {
    expect(resolveRules({})).toEqual(DEFAULT_PATROL_RULES);
    expect(resolveRulesWithSource({}).sources.complianceThreshold).toBe('default');
  });

  it('un undefined no cuenta como override: ese nivel no opina', () => {
    const { rules, sources } = resolveRulesWithSource({
      tenant: { complianceThreshold: 85 },
      site: { complianceThreshold: undefined },
    });

    expect(rules.complianceThreshold).toBe(85);
    expect(sources.complianceThreshold).toBe('tenant');
  });
});
