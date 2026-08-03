import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface OpenSupportAccessInput {
  readonly tenantId: string;
  readonly reason: string;
  readonly minutes?: number;
}

/**
 * Acceso de soporte del SUPERADMIN a un tenant. Ver issue #109.
 *
 * El mecanismo existia en la base desde la migracion de RLS —
 * `app_has_audited_support_access()` y `support_access_log`— pero estaba MUERTO:
 * nada seteaba `app.support_access_id`, asi que la funcion siempre devolvia
 * false. Esto lo activa.
 *
 * Por que asi y no dandole al SUPERADMIN un rol con BYPASSRLS: un bypass no deja
 * rastro y no caduca. Aca cada entrada a los datos de una empresa exige un
 * motivo escrito, vence sola, y queda registrada en una tabla que el propio
 * ADMIN del tenant puede leer. El soporte que mira tus datos sin que lo sepas es
 * exactamente lo que un cliente de seguridad privada no puede aceptar.
 *
 * Corre FUERA del contexto de tenant (el SUPERADMIN no tiene uno), asi que usa
 * el DataSource directo en vez de TenantContextService.
 */
@Injectable()
export class SupportAccessService {
  constructor(private readonly dataSource: DataSource) {}

  private async assertSuperadmin(userId: string) {
    const filas = await this.dataSource.query(
      `SELECT 1 FROM platform_memberships
       WHERE user_id = $1 AND role_key = 'SUPERADMIN'`,
      [userId],
    );
    if (!filas.length) throw new ForbiddenException('Solo el SUPERADMIN abre accesos de soporte');
  }

  /** Abre una ventana de acceso con motivo y vencimiento. */
  async open(superadminId: string, input: OpenSupportAccessInput) {
    await this.assertSuperadmin(superadminId);

    const motivo = input.reason.trim();
    if (motivo.length < 10) {
      throw new BadRequestException('El motivo debe explicar el acceso (mínimo 10 caracteres)');
    }
    // Techo duro: una ventana de soporte no es una sesion permanente.
    const minutos = Math.min(Math.max(input.minutes ?? 60, 5), 8 * 60);

    const existente = await this.dataSource.query(
      `SELECT id FROM support_access_log
       WHERE tenant_id = $1 AND superadmin_user_id = $2
         AND ended_at IS NULL AND expires_at > now()`,
      [input.tenantId, superadminId],
    );
    if (existente.length) {
      throw new ConflictException('Ya tienes un acceso de soporte abierto a esta empresa');
    }

    const tenant = await this.dataSource.query(
      `SELECT id, name FROM tenants WHERE id = $1`,
      [input.tenantId],
    );
    if (!tenant.length) throw new NotFoundException('La empresa no existe');

    const [creado] = await this.dataSource.query(
      `INSERT INTO support_access_log (tenant_id, superadmin_user_id, reason, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))
       RETURNING id, started_at, expires_at`,
      [input.tenantId, superadminId, motivo, minutos],
    );

    return {
      supportAccessId: creado.id,
      tenantId: input.tenantId,
      tenantName: tenant[0].name,
      reason: motivo,
      startedAt: creado.started_at,
      expiresAt: creado.expires_at,
    };
  }

  /** Cierra la ventana antes de que venza. */
  async close(superadminId: string, supportAccessId: string) {
    await this.assertSuperadmin(superadminId);
    const filas = await this.dataSource.query(
      `UPDATE support_access_log SET ended_at = now()
       WHERE id = $1 AND superadmin_user_id = $2 AND ended_at IS NULL
       RETURNING id, tenant_id`,
      [supportAccessId, superadminId],
    );
    if (!filas.length) throw new NotFoundException('No hay un acceso abierto con ese id');
    return { supportAccessId, tenantId: filas[0].tenant_id, closed: true };
  }

  /** Accesos vigentes del SUPERADMIN, para saber qué tiene abierto. */
  async active(superadminId: string) {
    await this.assertSuperadmin(superadminId);
    const filas = await this.dataSource.query(
      `SELECT a.id, a.tenant_id, t.name AS tenant_name, a.reason,
              a.started_at, a.expires_at
       FROM support_access_log a
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.superadmin_user_id = $1 AND a.ended_at IS NULL AND a.expires_at > now()
       ORDER BY a.started_at DESC`,
      [superadminId],
    );
    return filas.map((f: Record<string, unknown>) => ({
      supportAccessId: f.id,
      tenantId: f.tenant_id,
      tenantName: f.tenant_name,
      reason: f.reason,
      startedAt: f.started_at,
      expiresAt: f.expires_at,
    }));
  }

  /**
   * Valida que el acceso siga vigente y devuelve su tenant. Lo usa el
   * interceptor antes de abrir la transaccion con contexto de soporte.
   */
  async resolve(supportAccessId: string, userId: string) {
    const filas = await this.dataSource.query(
      `SELECT tenant_id FROM support_access_log
       WHERE id = $1 AND superadmin_user_id = $2
         AND ended_at IS NULL AND started_at <= now() AND expires_at > now()`,
      [supportAccessId, userId],
    );
    return filas.length ? (filas[0].tenant_id as string) : null;
  }

}
