import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';

/**
 * Retencion por defecto antes del purge definitivo. Es el seguro contra el
 * borrado por error: se puede subir por solicitud (retentionDays del DTO).
 */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Tablas con columna tenant_id que son registro de PLATAFORMA, no datos del
 * tenant: la solicitud de borrado es la prueba juridica y debe sobrevivir al
 * purge, asi que no se exporta ni cuenta como fila huerfana.
 */
const PLATFORM_REGISTRY_TABLES: readonly string[] = ['tenant_deletions'];

type DeletionStatus = 'programado' | 'cancelado' | 'ejecutado';

interface DeletionRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  requested_at: Date;
  purge_after: Date;
  status: DeletionStatus;
  reason: string;
  executed_at: Date | null;
}

interface TenantListRow {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  status: string;
}

const DELETION_COLUMNS =
  'id, tenant_id, requested_by, requested_at, purge_after, status, reason, executed_at';

@Injectable()
export class TenantDataService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Vuelca a JSON todas las tablas con columna tenant_id, descubiertas desde
   * information_schema: una tabla futura entra sola al export, sin tocar este
   * codigo (mismo criterio que tenant-isolation.integration.spec.ts).
   */
  async exportTenant(actorId: string, tenantId: string) {
    return this.withPlatformActor(actorId, async (manager) => {
      const tenant = await this.requireTenant(manager, actorId, tenantId);
      const tables = await this.tenantTables(manager);

      const data: Record<string, unknown[]> = {};
      const tableCounts: Record<string, number> = {};
      let totalRows = 0;
      for (const table of tables) {
        const rows = await manager.query<Array<{ dump: unknown[] }>>(
          `SELECT platform_export_tenant_table($1, $2, $3) AS dump`,
          [actorId, tenantId, table],
        );
        const dump = rows[0]?.dump ?? [];
        data[table] = dump;
        tableCounts[table] = dump.length;
        totalRows += dump.length;
      }

      return {
        manifest: {
          tenantId,
          slug: tenant.slug,
          displayName: tenant.display_name,
          legalName: tenant.legal_name,
          generatedAt: new Date().toISOString(),
          tableCount: tables.length,
          totalRows,
          tables: tableCounts,
          // Aun no existe almacenamiento de archivos en la API: cuando las
          // fotos de evidencia tengan disco/bucket, el zip se arma con
          // `archiver` en un endpoint de descarga aparte.
          photos: {
            status: 'pendiente',
            detail:
              'Sin almacenamiento de fotos en la API todavia; el zip se implementara con archiver cuando exista.',
          },
        },
        data,
      };
    });
  }

  async scheduleDeletion(
    actorId: string,
    tenantId: string,
    reason: string,
    retentionDays: number = DEFAULT_RETENTION_DAYS,
  ) {
    return this.withPlatformActor(actorId, async (manager) => {
      await this.requireTenant(manager, actorId, tenantId);
      try {
        const rows = await manager.query<DeletionRow[]>(
          `INSERT INTO tenant_deletions (tenant_id, requested_by, reason, purge_after)
           VALUES ($1, $2, $3, now() + make_interval(days => $4))
           RETURNING ${DELETION_COLUMNS}`,
          [tenantId, actorId, reason, retentionDays],
        );
        return this.toDeletion(rows[0]!);
      } catch (error) {
        if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
          throw new ConflictException(
            'Ya existe un borrado programado para esta empresa',
          );
        }
        throw error;
      }
    });
  }

  async cancelDeletion(actorId: string, tenantId: string) {
    return this.withPlatformActor(actorId, async (manager) => {
      const rows = await manager.query<DeletionRow[]>(
        `UPDATE tenant_deletions
         SET status = 'cancelado'
         WHERE tenant_id = $1 AND status = 'programado'
         RETURNING ${DELETION_COLUMNS}`,
        [tenantId],
      );
      const cancelled = rows[0];
      if (!cancelled) {
        throw new NotFoundException(
          'No hay un borrado programado para esta empresa',
        );
      }
      return this.toDeletion(cancelled);
    });
  }

  async pendingDeletions(actorId: string) {
    return this.withPlatformActor(actorId, async (manager) => {
      const rows = await manager.query<DeletionRow[]>(
        `SELECT ${DELETION_COLUMNS}
         FROM tenant_deletions
         WHERE status = 'programado'
         ORDER BY purge_after ASC`,
      );
      return rows.map((row) => this.toDeletion(row));
    });
  }

  /**
   * Purga definitiva. Corre completa dentro de UNA transaccion: si despues del
   * DELETE queda una sola fila huerfana, el throw revierte tambien el DELETE y
   * el tenant queda intacto — nunca un borrado a medias.
   */
  async executeDeletion(actorId: string, tenantId: string) {
    return this.withPlatformActor(actorId, async (manager) => {
      const requests = await manager.query<
        Array<{ id: string; purge_after: Date; expired: boolean }>
      >(
        `SELECT id, purge_after, purge_after < now() AS expired
         FROM tenant_deletions
         WHERE tenant_id = $1 AND status = 'programado'`,
        [tenantId],
      );
      const request = requests[0];
      if (!request) {
        throw new NotFoundException(
          'No hay un borrado programado para esta empresa',
        );
      }
      if (!request.expired) {
        throw new ConflictException(
          `La retencion vence el ${new Date(request.purge_after).toISOString()}: el purge no se ejecuta antes`,
        );
      }

      const tables = await this.tenantTables(manager);

      try {
        await manager.query(`SELECT platform_purge_tenant($1, $2)`, [
          actorId,
          tenantId,
        ]);
      } catch (error) {
        if (error instanceof QueryFailedError && error.driverError?.code === '23503') {
          throw new ConflictException(
            `El purge quedo bloqueado por una clave foranea RESTRICT (${String(
              error.driverError?.constraint ?? 'desconocida',
            )}); ver docs/borrado-y-exportacion.md`,
          );
        }
        throw error;
      }

      const orphanTables: string[] = [];
      for (const table of tables) {
        const counts = await manager.query<Array<{ remaining: string }>>(
          `SELECT platform_count_tenant_rows($1, $2, $3) AS remaining`,
          [actorId, tenantId, table],
        );
        if (Number(counts[0]?.remaining ?? 0) > 0) orphanTables.push(table);
      }
      if (orphanTables.length > 0) {
        throw new ConflictException(
          `Quedaron filas del tenant en: ${orphanTables.join(', ')}. Se revirtio el borrado completo.`,
        );
      }

      const updated = await manager.query<DeletionRow[]>(
        `UPDATE tenant_deletions
         SET status = 'ejecutado', executed_at = now()
         WHERE id = $1
         RETURNING ${DELETION_COLUMNS}`,
        [request.id],
      );
      return this.toDeletion(updated[0]!);
    });
  }

  private async tenantTables(manager: EntityManager): Promise<string[]> {
    const rows = await manager.query<Array<{ table_name: string }>>(`
      SELECT DISTINCT columns.table_name
      FROM information_schema.columns columns
      JOIN information_schema.tables tables
        ON tables.table_schema = columns.table_schema
       AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND columns.column_name = 'tenant_id'
        AND tables.table_type = 'BASE TABLE'
      ORDER BY columns.table_name
    `);
    return rows
      .map((row) => row.table_name)
      .filter((table) => !PLATFORM_REGISTRY_TABLES.includes(table));
  }

  private async requireTenant(
    manager: EntityManager,
    actorId: string,
    tenantId: string,
  ): Promise<TenantListRow> {
    const rows = await manager.query<TenantListRow[]>(
      `SELECT * FROM platform_list_tenants($1)`,
      [actorId],
    );
    const tenant = rows.find((row) => row.id === tenantId);
    if (!tenant) throw new NotFoundException('Empresa no encontrada');
    return tenant;
  }

  private toDeletion(row: DeletionRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      purgeAfter: row.purge_after,
      status: row.status,
      reason: row.reason,
      executedAt: row.executed_at,
    };
  }

  private withPlatformActor<T>(
    actorId: string,
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);
      return operation(manager);
    });
  }
}
