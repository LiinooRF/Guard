import { Injectable, Logger } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

export interface AuditEntry {
  readonly actorId: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly summary?: string;
}

export interface AuditFilter {
  readonly actorId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

/** Acciones sensibles que se registran. Agregar una aca es la unica ceremonia. */
export const AUDIT_ACTIONS = [
  'usuario.creado',
  'usuario.desactivado',
  'usuario.sesiones_revocadas',
  'recinto.creado',
  'recinto.desactivado',
  'punto.creado',
  'punto.modificado',
  'etiqueta.registrada',
  'etiqueta.retirada',
  'ruta.creada',
  'ruta.modificada',
  'reglas.modificadas',
  'escalamiento.modificado',
  'politica_seguridad.modificada',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Registrar una accion JAMAS puede voltear la operacion que la origino: si la
   * auditoria falla, el usuario ya se creo y revertirlo seria peor. Se avisa en
   * el log y se sigue. La contrapartida es que un fallo aca deja un hueco, asi
   * que el log de la aplicacion es la red de seguridad de la red de seguridad.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.tenantContext.manager.query(
        `INSERT INTO audit_log (
          tenant_id, actor_id, actor_label, action, entity_type, entity_id, summary
        ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [
          entry.actorId,
          entry.actorLabel,
          entry.action,
          entry.entityType,
          entry.entityId ?? null,
          entry.summary ?? null,
        ],
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'auditoria_fallo',
          action: entry.action,
          entity_type: entry.entityType,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async list(filter: AuditFilter) {
    const condiciones: string[] = [];
    const valores: unknown[] = [];
    const agrega = (sql: string, valor: unknown) => {
      valores.push(valor);
      condiciones.push(sql.replace('?', `$${valores.length}`));
    };
    if (filter.actorId) agrega('actor_id = ?', filter.actorId);
    if (filter.action) agrega('action = ?', filter.action);
    if (filter.from) agrega('created_at >= ?', filter.from);
    if (filter.to) agrega('created_at <= ?', filter.to);

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    valores.push(Math.min(filter.limit ?? 100, 500));

    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      actor_id: string | null;
      actor_label: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      summary: string | null;
      created_at: Date;
    }>>(
      `SELECT id, actor_id, actor_label, action, entity_type, entity_id, summary, created_at
       FROM audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${valores.length}`,
      valores,
    );
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }

  /** Las acciones distintas presentes, para poblar el filtro de la interfaz. */
  async availableActions() {
    const rows = await this.tenantContext.manager.query<Array<{ action: string }>>(
      `SELECT DISTINCT action FROM audit_log ORDER BY action`,
    );
    return rows.map((r) => r.action);
  }
}
