import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import {
  CONFIG_AREA_LABELS,
  CONFIG_SCOPE_LABELS,
  describeChange,
  parameterCard,
  type ConfigArea,
  type ConfigScope,
} from './config-audit.catalog';

export interface ConfigAuditFilter {
  readonly area?: ConfigArea;
  readonly scope?: ConfigScope;
  readonly targetId?: string;
  readonly paramKey?: string;
  readonly actorId?: string;
  /** Instante ISO-8601. Para rangos exactos entre sistemas. */
  readonly from?: string;
  readonly to?: string;
  /** Dia calendario AAAA-MM-DD, en la zona horaria del recinto. */
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly timeZone?: string;
  /** Valor nuevo exacto: "40", "true", "alta". Es lo que cierra la pregunta. */
  readonly newValue?: string;
  /**
   * Solo cambios donde el numero quedo mas chico ('bajo') o mas grande
   * ('subio'). No equivale a aflojar/apretar: depende del parametro. Bajar
   * complianceThreshold afloja, pero bajar gpsValidationRadiusM,
   * clockSkewToleranceMin o lateScanGraceMin APRIETA la regla. El panel no debe
   * rotular este filtro como "cambios que relajaron la regla".
   */
  readonly direction?: 'bajo' | 'subio';
  readonly limit?: number;
}

interface ChangeRow {
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
  site_name: string | null;
  checkpoint_name: string | null;
}

interface SummaryRow {
  area: string;
  param_key: string;
  cambios: string;
  ultimo: Date;
  ultimo_actor: string;
  ultimo_anterior: unknown;
  ultimo_nuevo: unknown;
}

/** Mismo tope que AuditService: es paginacion, no una regla de negocio. */
const TOPE_DE_FILAS = 500;
const FILAS_POR_DEFECTO = 100;

/**
 * Historial de cambios de configuracion del tenant de la sesion (#84).
 *
 * SOLO LEE. Las filas las escribe un trigger de PostgreSQL colgado de las tablas
 * de configuracion (ver la migracion CreateConfigChangeLog): la aplicacion no
 * tiene INSERT sobre `config_change_log`, asi que ni este servicio ni ningun
 * otro puede fabricar, corregir ni omitir una fila. Un registro que el propio
 * auditado puede editar no sirve como control.
 *
 * Aislamiento: todo cuelga de la politica RLS de la tabla. Aca no hay un
 * `WHERE tenant_id = ...` que se pueda olvidar, y por eso tampoco hace falta.
 */
@Injectable()
export class ConfigAuditService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * El historial, filtrado. Devuelve ademas la zona horaria con la que se
   * interpretaron los dias: sin decirla, un rango "del 1 al 31" es ambiguo y el
   * admin no sabe si el cambio de las 23:40 entro o no.
   */
  async history(filter: ConfigAuditFilter) {
    const necesitaZona = Boolean(filter.fromDay || filter.toDay);
    const timeZone = necesitaZona
      ? await this.resolverZona(filter.timeZone, filter.targetId)
      : null;

    const valores: unknown[] = [];
    const condiciones: string[] = [];
    /** Empuja el valor y devuelve su marcador. Nada se concatena al SQL. */
    const p = (valor: unknown) => {
      valores.push(valor);
      return `$${valores.length}`;
    };

    if (filter.area) condiciones.push(`cambio.area = ${p(filter.area)}`);
    if (filter.scope) condiciones.push(`cambio.scope = ${p(filter.scope)}`);
    if (filter.targetId) condiciones.push(`cambio.target_id = ${p(filter.targetId)}::uuid`);
    if (filter.paramKey) condiciones.push(`cambio.param_key = ${p(filter.paramKey)}`);
    if (filter.actorId) condiciones.push(`cambio.actor_id = ${p(filter.actorId)}::uuid`);
    if (filter.from) condiciones.push(`cambio.changed_at >= ${p(filter.from)}::timestamptz`);
    if (filter.to) condiciones.push(`cambio.changed_at <= ${p(filter.to)}::timestamptz`);

    if (timeZone && filter.fromDay) {
      const dia = p(filter.fromDay);
      const zona = p(timeZone);
      condiciones.push(`cambio.changed_at >= (${dia}::date::timestamp AT TIME ZONE ${zona})`);
    }
    if (timeZone && filter.toDay) {
      // El dia se suma al timestamp SIN zona y recien despues se convierte. Al
      // reves, un dia son 24 horas fijas y el rango se corre una hora en el
      // cambio de horario. El limite es exclusivo: asi el ultimo dia entra
      // entero, hasta las 23:59:59.
      const dia = p(filter.toDay);
      const zona = p(timeZone);
      condiciones.push(
        `cambio.changed_at < ((${dia}::date::timestamp + INTERVAL '1 day') AT TIME ZONE ${zona})`,
      );
    }

    if (filter.newValue !== undefined) {
      condiciones.push(`cambio.new_value = ${p(this.aJsonb(filter.newValue))}::jsonb`);
    }
    if (filter.direction) {
      // Solo tiene sentido entre numeros; con booleanos o listas no hay "menos".
      const comparador = filter.direction === 'bajo' ? '<' : '>';
      condiciones.push(
        `(jsonb_typeof(cambio.old_value) = 'number'
          AND jsonb_typeof(cambio.new_value) = 'number'
          AND (cambio.new_value #>> '{}')::numeric
              ${comparador} (cambio.old_value #>> '{}')::numeric)`,
      );
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const limite = p(Math.min(filter.limit ?? FILAS_POR_DEFECTO, TOPE_DE_FILAS));

    const rows = await this.tenantContext.manager.query<ChangeRow[]>(
      `SELECT cambio.id,
              cambio.area,
              cambio.scope,
              cambio.target_id,
              cambio.param_key,
              cambio.old_value,
              cambio.new_value,
              cambio.actor_id,
              cambio.actor_label,
              cambio.support_access_id,
              cambio.changed_at,
              recinto.name AS site_name,
              punto.name AS checkpoint_name
         FROM config_change_log cambio
         LEFT JOIN sites recinto
           ON cambio.scope = 'site'
          AND recinto.tenant_id = cambio.tenant_id
          AND recinto.id = cambio.target_id
         LEFT JOIN checkpoints punto
           ON cambio.scope = 'checkpoint'
          AND punto.tenant_id = cambio.tenant_id
          AND punto.id = cambio.target_id
        ${where}
        ORDER BY cambio.changed_at DESC, cambio.id DESC
        LIMIT ${limite}`,
      valores,
    );

    return {
      timeZone,
      changes: (rows ?? []).map((row) => this.vistaDeCambio(row)),
    };
  }

  /**
   * Que parametros tienen historial, con su ultimo cambio. Es lo que pinta el
   * filtro del panel y la vista de "que se ha tocado aca".
   */
  async parameters(area?: ConfigArea) {
    const valores: unknown[] = [];
    const where = area ? 'WHERE cambio.area = $1' : '';
    if (area) valores.push(area);

    const rows = await this.tenantContext.manager.query<SummaryRow[]>(
      `SELECT cambio.area,
              cambio.param_key,
              count(*)::text AS cambios,
              max(cambio.changed_at) AS ultimo,
              (array_agg(cambio.actor_label ORDER BY cambio.changed_at DESC))[1]
                AS ultimo_actor,
              (array_agg(cambio.old_value ORDER BY cambio.changed_at DESC))[1]
                AS ultimo_anterior,
              (array_agg(cambio.new_value ORDER BY cambio.changed_at DESC))[1]
                AS ultimo_nuevo
         FROM config_change_log cambio
         ${where}
        GROUP BY cambio.area, cambio.param_key
        ORDER BY max(cambio.changed_at) DESC`,
      valores,
    );

    return (rows ?? []).map((row) => {
      const descripcion = describeChange(
        row.area,
        row.param_key,
        row.ultimo_anterior,
        row.ultimo_nuevo,
      );
      return {
        area: row.area,
        areaLabel: CONFIG_AREA_LABELS[row.area as ConfigArea] ?? row.area,
        paramKey: row.param_key,
        parameter: parameterCard(row.area, row.param_key),
        label: descripcion.label,
        changes: Number(row.cambios ?? 0),
        lastChangedAt: row.ultimo,
        lastActorLabel: row.ultimo_actor,
        lastSummary: descripcion.summary,
      };
    });
  }

  private vistaDeCambio(row: ChangeRow) {
    const descripcion = describeChange(row.area, row.param_key, row.old_value, row.new_value);
    return {
      id: row.id,
      area: row.area,
      areaLabel: CONFIG_AREA_LABELS[row.area as ConfigArea] ?? row.area,
      scope: row.scope,
      scopeLabel: CONFIG_SCOPE_LABELS[row.scope as ConfigScope] ?? row.scope,
      targetId: row.target_id,
      targetName: row.site_name ?? row.checkpoint_name ?? null,
      paramKey: row.param_key,
      parameter: descripcion.card,
      label: descripcion.label,
      oldValue: row.old_value ?? null,
      newValue: row.new_value ?? null,
      oldLabel: descripcion.from,
      newLabel: descripcion.to,
      summary: descripcion.summary,
      actorId: row.actor_id,
      actorLabel: row.actor_label,
      // Un cambio hecho por soporte de la plataforma no es lo mismo que uno
      // hecho por el admin de la empresa, y el admin tiene derecho a distinguirlo.
      viaSupportAccess: row.support_access_id !== null,
      changedAt: row.changed_at,
    };
  }

  /**
   * Zona horaria con la que se interpretan los dias del filtro.
   *
   * En orden: la que pidio el llamador (si PostgreSQL la conoce), la del recinto
   * consultado, la mas usada por los recintos de la empresa y, en ultimo
   * termino, UTC. Nada de una zona escrita a mano en el codigo: sale siempre de
   * `sites.timezone`, que es el dato del negocio.
   */
  private async resolverZona(pedida: string | undefined, targetId?: string): Promise<string> {
    const rows = await this.tenantContext.manager.query<Array<{ zona: string }>>(
      `SELECT COALESCE(
                (SELECT nombre.name FROM pg_timezone_names nombre WHERE nombre.name = $1::text),
                (SELECT recinto.timezone FROM sites recinto
                  WHERE recinto.tenant_id = app_tenant_id()
                    AND recinto.id = $2::uuid),
                (SELECT recinto.timezone
                   FROM sites recinto
                   JOIN checkpoints punto
                     ON punto.tenant_id = recinto.tenant_id
                    AND punto.site_id = recinto.id
                  WHERE recinto.tenant_id = app_tenant_id()
                    AND punto.id = $2::uuid),
                (SELECT recinto.timezone FROM sites recinto
                  WHERE recinto.tenant_id = app_tenant_id()
                  GROUP BY recinto.timezone
                  ORDER BY count(*) DESC, recinto.timezone
                  LIMIT 1),
                'UTC'
              ) AS zona`,
      [pedida ?? null, targetId ?? null],
    );
    return rows?.[0]?.zona ?? 'UTC';
  }

  /**
   * El valor buscado llega como texto en la query. "40" es el numero 40 y
   * "alta" es la cadena "alta": se intenta leer como JSON y, si no lo es, se
   * envuelve. Asi `?newValue=40` encuentra el umbral en 40 y no el texto "40".
   */
  private aJsonb(valor: string): string {
    try {
      JSON.parse(valor);
      return valor;
    } catch {
      return JSON.stringify(valor);
    }
  }
}
