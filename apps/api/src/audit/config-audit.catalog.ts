import {
  PATROL_RULE_CATALOG,
  RULE_UNIT_LABELS,
  type PatrolRules,
  type RuleUnit,
} from '@voxia/shared';

import { FEATURE_CATALOG, type FeatureFlagKey } from '../rules/feature-flags.catalog';

/**
 * Como se le muestra al jefe de operaciones un cambio de configuracion (#84).
 *
 * Codigo puro: no toca la base ni Nest. Traduce la clave tecnica y el valor
 * crudo del historial a algo que se lee sin saber como se llama el campo por
 * dentro — "Umbral de cumplimiento: 70% -> 40%" y no
 * "complianceThreshold: 70 -> 40".
 *
 * La ficha sale del catalogo que ya existe (PATROL_RULE_CATALOG para las reglas,
 * FEATURE_CATALOG para los modulos), no de una lista propia: si manana entra una
 * regla nueva, el historial la muestra con su nombre solo, sin tocar este
 * archivo. Una lista paralela aca se desincronizaria al primer parametro nuevo.
 */

/** De donde salio el cambio. Es la dimension que separa reglas de licencia. */
export const CONFIG_AREAS = ['reglas', 'modulos', 'licencia'] as const;
export type ConfigArea = (typeof CONFIG_AREAS)[number];

export const CONFIG_AREA_LABELS: Record<ConfigArea, string> = {
  reglas: 'Reglas de operacion',
  modulos: 'Modulos encendidos por la empresa',
  licencia: 'Modulos incluidos en la licencia',
};

/** Nivel de la cascada donde se escribio el cambio. */
export const CONFIG_SCOPES = ['tenant', 'site', 'checkpoint'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const CONFIG_SCOPE_LABELS: Record<ConfigScope, string> = {
  tenant: 'Toda la empresa',
  site: 'Recinto',
  checkpoint: 'Punto de control',
};

export interface ParameterCard {
  key: string;
  label: string;
  description: string;
  unit: RuleUnit | null;
}

const esClaveDeRegla = (key: string): key is keyof PatrolRules =>
  Object.prototype.hasOwnProperty.call(PATROL_RULE_CATALOG, key);

const esClaveDeModulo = (key: string): key is FeatureFlagKey =>
  Object.prototype.hasOwnProperty.call(FEATURE_CATALOG, key);

/**
 * Ficha del parametro, o null si la clave no esta en ningun catalogo.
 *
 * Devolver null y no inventar una ficha es a proposito: en el historial puede
 * quedar un parametro que se retiro del producto o que un panel viejo escribio
 * mal, y borrarlo de la vista seria esconder justo lo que hay que revisar.
 */
export function parameterCard(area: string, key: string): ParameterCard | null {
  if (area === 'reglas' && esClaveDeRegla(key)) {
    const ficha = PATROL_RULE_CATALOG[key];
    return {
      key,
      label: ficha.label,
      description: ficha.description,
      unit: ficha.unit,
    };
  }
  if ((area === 'modulos' || area === 'licencia') && esClaveDeModulo(key)) {
    const modulo = FEATURE_CATALOG[key];
    return {
      key,
      label: modulo.label,
      description: modulo.description,
      unit: null,
    };
  }
  return null;
}

/**
 * El valor, en palabras. `undefined` y `null` de SQL significan lo mismo aca:
 * ese nivel NO definia el parametro y lo heredaba del nivel de arriba. No es un
 * valor apagado — la diferencia importa, porque "lo dejo de definir" y "lo puso
 * en no" tienen consecuencias distintas.
 */
export function describeValue(valor: unknown, ficha: ParameterCard | null): string {
  if (valor === null || valor === undefined) return 'sin definir (hereda)';
  if (typeof valor === 'boolean') return valor ? 'si' : 'no';
  if (typeof valor === 'number') return conUnidad(valor, ficha?.unit ?? null);
  if (typeof valor === 'string') return valor;
  if (Array.isArray(valor)) {
    return valor.length ? valor.map((item) => String(item)).join(', ') : 'ninguno';
  }
  return JSON.stringify(valor);
}

function conUnidad(valor: number, unit: RuleUnit | null): string {
  if (!unit) return String(valor);
  const etiqueta = RULE_UNIT_LABELS[unit];
  // El porcentaje va pegado al numero; el resto de las unidades, separado.
  return etiqueta === '%' ? `${valor}%` : `${valor} ${etiqueta}`;
}

/**
 * Una linea que resume el cambio completo, lista para una tabla o un correo:
 * "Umbral de cumplimiento: 70% -> 40%".
 */
export function describeChange(
  area: string,
  key: string,
  anterior: unknown,
  nuevo: unknown,
): { card: ParameterCard | null; label: string; from: string; to: string; summary: string } {
  const card = parameterCard(area, key);
  const label = card?.label ?? key;
  const from = describeValue(anterior, card);
  const to = describeValue(nuevo, card);
  return { card, label, from, to, summary: `${label}: ${from} -> ${to}` };
}
