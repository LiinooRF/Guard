import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { createAuthActionToken } from '../auth/auth-action-token';
import { MailService } from '../auth/mail.service';
import { filasDe } from '../consent/sql-result';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import type { CreateSiteDto } from './dto/create-site.dto';
import type { CreateTenantUserDto, UpdateTenantUserDto } from './dto/create-user.dto';
import type { ImportCheckpointRowDto } from './dto/import-checkpoints.dto';
import type { RegisterTagDto } from './dto/register-tag.dto';
import type { SiteBusinessHourDto, SiteHolidayDto } from './dto/site-calendar.dto';
import type { UpdateAuthPolicyDto } from './dto/update-auth-policy.dto';
import type { UpdateCheckpointDto } from './dto/update-checkpoint.dto';
import type { UpdateSiteDto } from './dto/update-site.dto';
import { normalizarUidDeEtiqueta, normalizarUidNfc, uidNfcValido } from './uid-nfc';

interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  given_name: string;
  family_name: string;
  nfc_card_uid?: string | null;
  role_key: 'ADMIN' | 'SUPERVISOR' | 'GUARDIA';
  is_active: boolean;
  site_ids: string[];
}

interface SiteRow {
  id: string;
  branch_name: string;
  name: string;
  address: string;
  latitude: string | null;
  longitude: string | null;
  timezone: string;
  is_active: boolean;
  checkpoint_count: number;
  supervisor_count: number;
}

interface CheckpointRow {
  id: string;
  site_id: string;
  name: string;
  description: string | null;
  suggested_order: number;
  kind: 'normal' | 'acceso_critico';
  latitude: string | null;
  longitude: string | null;
  requires_photo: boolean | null;
  instructions: string | null;
  is_active: boolean;
}

interface TagRow {
  id: string;
  checkpoint_id: string;
  tech: 'nfc' | 'qr';
  uid: string;
  is_active: boolean;
  installed_at: string;
  replaced_at: string | null;
}

/** Un punto con el nombre de su recinto: lo que necesita el resumen de auditoria. */
export interface PuntoUbicado {
  id: string;
  name: string;
  site_id: string;
  site_name: string;
}

/**
 * Quien pide una escritura de terreno, y con que alcance (#309).
 *
 * `actorId` sale SIEMPRE de `request.user.sub` —el token—, nunca del cuerpo ni
 * de la URL, y es lo que queda en `audit_log`.
 *
 * `supervisorId` es opcional y solo lo manda el camino del SUPERVISOR: ata la
 * sentencia de escritura a `supervisor_sites`. El camino del ADMIN no lo manda
 * y opera sobre el tenant entero, que es lo que corresponde a ese rol.
 */
export interface ContextoEscritura {
  readonly actorId: string;
  readonly supervisorId?: string;
}

/**
 * El guardia de alcance, PEGADO a la sentencia que escribe (#309).
 *
 * No reemplaza al pre-chequeo (`ensureAssignedSite`): ese existe para elegir el
 * codigo HTTP —404 si el punto no existe, 403 si existe y no es suyo— y este
 * existe para que entre comprobar y escribir no quede una ventana, y para que
 * un llamador futuro que se saltee el pre-chequeo falle CERRADO en vez de
 * escribir. Si alguien "simplifica" quitando uno de los dos, quita justo el que
 * no era decorativo.
 *
 * `columnaSitio` es un literal del propio codigo (`checkpoints.site_id`), nunca
 * entrada del usuario: los valores siempre van como parametro ligado.
 */
function alcanceDelSupervisor(
  supervisorId: string | undefined,
  columnaSitio: string,
  indice: number,
): { sql: string; params: string[] } {
  if (!supervisorId) return { sql: '', params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM supervisor_sites ss
            WHERE ss.site_id = ${columnaSitio} AND ss.supervisor_id = $${indice})`,
    params: [supervisorId],
  };
}

/**
 * Cero filas despues de una escritura acotada: si el alcance estaba puesto es
 * 403 (existia cuando se comprobo y dejo de ser suyo), si no es 404.
 */
function faltaLaFila(contexto: ContextoEscritura | undefined, queNoEsta: string): Error {
  return contexto?.supervisorId
    ? new ForbiddenException('No tienes este recinto asignado')
    : new NotFoundException(queNoEsta);
}

@Injectable()
export class AdminService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async listUsers() {
    const rows = await this.tenantContext.manager.query<UserRow[]>(`
      SELECT
        users.id,
        users.email,
        users.username,
        users.given_name,
        users.family_name,
        users.nfc_card_uid,
        memberships.role_key,
        users.is_active,
        COALESCE(
          array_agg(supervisor_sites.site_id)
            FILTER (WHERE supervisor_sites.site_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS site_ids
      FROM memberships
      JOIN users ON users.id = memberships.user_id
      LEFT JOIN supervisor_sites
        ON supervisor_sites.supervisor_id = users.id
       AND memberships.role_key = 'SUPERVISOR'
      GROUP BY users.id, memberships.role_key
      ORDER BY memberships.role_key, users.given_name, users.family_name
    `);
    return rows.map((user) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      givenName: user.given_name,
      familyName: user.family_name,
      nfcCardUid: user.nfc_card_uid ?? null,
      role: user.role_key,
      isActive: user.is_active,
      siteIds: user.site_ids,
    }));
  }

  async getAuthPolicy() {
    const rows = await this.tenantContext.manager.query<Array<{
      max_failed_attempts: number;
      window_seconds: number;
      base_lock_seconds: number;
      max_lock_seconds: number;
    }>>(`
      SELECT max_failed_attempts, window_seconds, base_lock_seconds, max_lock_seconds
      FROM tenant_auth_policies
      WHERE tenant_id = app_tenant_id()
    `);
    const policy = rows[0];
    return {
      maxFailedAttempts: policy?.max_failed_attempts ?? 5,
      windowSeconds: policy?.window_seconds ?? 900,
      baseLockSeconds: policy?.base_lock_seconds ?? 300,
      maxLockSeconds: policy?.max_lock_seconds ?? 3600,
    };
  }

  async updateAuthPolicy(input: UpdateAuthPolicyDto) {
    if (input.maxLockSeconds < input.baseLockSeconds) {
      throw new BadRequestException('El bloqueo máximo no puede ser menor al inicial');
    }
    await this.tenantContext.manager.query(
      `INSERT INTO tenant_auth_policies (
        tenant_id, max_failed_attempts, window_seconds,
        base_lock_seconds, max_lock_seconds
      ) VALUES (app_tenant_id(), $1, $2, $3, $4)
      ON CONFLICT (tenant_id) DO UPDATE SET
        max_failed_attempts = EXCLUDED.max_failed_attempts,
        window_seconds = EXCLUDED.window_seconds,
        base_lock_seconds = EXCLUDED.base_lock_seconds,
        max_lock_seconds = EXCLUDED.max_lock_seconds,
        updated_at = now()`,
      [
        input.maxFailedAttempts,
        input.windowSeconds,
        input.baseLockSeconds,
        input.maxLockSeconds,
      ],
    );
    return this.getAuthPolicy();
  }

  async listSecurityEvents() {
    const rows = await this.tenantContext.manager.query<Array<{
      id: string;
      event_type: string;
      created_at: Date;
    }>>(`
      SELECT id, event_type, created_at
      FROM security_events
      ORDER BY created_at DESC
      LIMIT 50
    `);
    return rows.map((event) => ({
      id: event.id,
      type: event.event_type,
      createdAt: event.created_at,
    }));
  }

  async createUser(input: CreateTenantUserDto) {
    if (!input.email && !input.username) {
      throw new BadRequestException('Debes indicar correo o nombre de usuario');
    }
    if (!input.email && !input.password) {
      throw new BadRequestException('La credencial sin correo requiere una clave inicial');
    }
    const userId = randomUUID();
    const provisionalPassword = input.email
      ? randomBytes(32).toString('base64url')
      : input.password!;
    const passwordHash = await hash(provisionalPassword, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    try {
      await this.tenantContext.manager.query(
        `SELECT admin_create_tenant_user($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          input.email?.toLowerCase() ?? null,
          input.username?.toLowerCase() ?? null,
          passwordHash,
          input.givenName,
          input.familyName,
          input.role,
        ],
      );
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
        throw new ConflictException('El correo o nombre de usuario ya está registrado');
      }
      throw error;
    }
    if (input.nfcCardUid) {
      const normalizedUid = normalizarUidNfc(input.nfcCardUid);
      try {
        await this.tenantContext.manager.query(
          `UPDATE users SET nfc_card_uid = $2, nfc_card_assigned_at = now() WHERE id = $1`,
          [userId, normalizedUid],
        );
      } catch (error) {
        if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
          throw new ConflictException('La tarjeta NFC ya está asignada a otro usuario');
        }
        throw error;
      }
    }
    if (input.email) {
      const invitation = createAuthActionToken(24 * 60 * 60 * 1000);
      await this.tenantContext.manager.query(
        `SELECT issue_auth_action_token(
          $1, app_tenant_id(), 'invitation', $2, $3
        )`,
        [userId, invitation.tokenHash, invitation.expiresAt],
      );
      try {
        const tenantRows = await this.tenantContext.manager.query<Array<{ tenant_id: string }>>(
          `SELECT app_tenant_id() AS tenant_id`,
        );
        const tenantId = tenantRows[0]?.tenant_id;
        if (!tenantId) throw new Error('No existe tenant en el contexto actual');
        await this.mail.invitation(
          input.email.toLowerCase(),
          invitation.token,
          tenantId,
          `invitation:${invitation.tokenHash}`,
        );
      } catch {
        throw new ServiceUnavailableException(
          'No fue posible enviar la invitación. Inténtalo nuevamente.',
        );
      }
      return { id: userId, invitationSent: true };
    }
    return { id: userId, invitationSent: false };
  }

  async setUserActive(userId: string, isActive: boolean) {
    /*
     * `filasDe` porque un UPDATE pelado devuelve [filas, rowCount] y no filas:
     * leido como arreglo mide 2 pase lo que pase, asi que el 404 de abajo no se
     * lanzaba nunca y desactivar al ADMIN del tenant —o a un id inventado—
     * respondia 200. Vale para todos los UPDATE/DELETE ... RETURNING de este
     * archivo.
     */
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE users
         SET is_active = $2, updated_at = now()
         WHERE id = $1
           AND EXISTS (
             SELECT 1 FROM memberships
             WHERE memberships.user_id = users.id
               AND memberships.role_key IN ('SUPERVISOR', 'GUARDIA')
           )
         RETURNING id`,
        [userId, isActive],
      ),
    );
    if (!result.length) throw new NotFoundException('Usuario administrable no encontrado');
    const revokedSessions = isActive ? 0 : await this.auth.revokeAllSessions(userId);
    return { id: userId, isActive, revokedSessions };
  }

  async updateUser(userId: string, input: UpdateTenantUserDto) {
    const current = await this.tenantContext.manager.query<Array<{
      id: string;
      role_key: 'SUPERVISOR' | 'GUARDIA';
    }>>(
      `SELECT users.id, memberships.role_key
       FROM users
       JOIN memberships ON memberships.user_id = users.id
       WHERE users.id = $1
         AND memberships.role_key IN ('SUPERVISOR', 'GUARDIA')`,
      [userId],
    );
    const user = current[0];
    if (!user) throw new NotFoundException('Usuario administrable no encontrado');

    const roleChanged = user.role_key !== input.role;
    let removedSiteAssignments = 0;
    if (roleChanged && input.role === 'GUARDIA') {
      // La asignacion referencia la membresia SUPERVISOR. Se retira antes de
      // cambiar el rol para no dejar recintos asignados a un guardia.
      const removed = await this.tenantContext.manager.query<Array<{ removed: number }>>(
        `WITH deleted AS (
           DELETE FROM supervisor_sites WHERE supervisor_id = $1 RETURNING 1
         )
         SELECT count(*)::int AS removed FROM deleted`,
        [userId],
      );
      removedSiteAssignments = Number(removed[0]?.removed ?? 0);
    }
    if (roleChanged) {
      await this.tenantContext.manager.query(
        `UPDATE memberships SET role_key = $2 WHERE user_id = $1`,
        [userId, input.role],
      );
    }

    if (input.nfcCardUid !== undefined) {
      const normalizedUid = input.nfcCardUid ? normalizarUidNfc(input.nfcCardUid) : null;
      try {
        await this.tenantContext.manager.query(
          `UPDATE users SET nfc_card_uid = $2, nfc_card_assigned_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE NULL END WHERE id = $1`,
          [userId, normalizedUid],
        );
      } catch (error) {
        if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
          throw new ConflictException('La tarjeta NFC ya está asignada a otro usuario');
        }
        throw error;
      }
    }

    const updated = await this.tenantContext.manager.query<Array<{
      id: string;
      given_name: string;
      family_name: string;
    }>>(
      `WITH changed AS (
         UPDATE users
         SET given_name = $2, family_name = $3, updated_at = now()
         WHERE id = $1
         RETURNING id, given_name, family_name
       )
       SELECT id, given_name, family_name FROM changed`,
      [userId, input.givenName.trim(), input.familyName.trim()],
    );
    if (!updated.length) throw new NotFoundException('Usuario administrable no encontrado');

    const revokedSessions = roleChanged ? await this.auth.revokeAllSessions(userId) : 0;
    return {
      id: userId,
      givenName: updated[0]!.given_name,
      familyName: updated[0]!.family_name,
      role: input.role,
      revokedSessions,
      removedSiteAssignments,
    };
  }

  async revokeUserSessions(userId: string) {
    const rows = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT users.id
       FROM users
       JOIN memberships ON memberships.user_id = users.id
       WHERE users.id = $1
         AND memberships.role_key IN ('SUPERVISOR', 'GUARDIA')`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Usuario administrable no encontrado');
    return { userId, revokedSessions: await this.auth.revokeAllSessions(userId) };
  }

  async listSites() {
    const rows = await this.tenantContext.manager.query<SiteRow[]>(`
      SELECT
        sites.id,
        sites.branch_name,
        sites.name,
        sites.address,
        sites.latitude,
        sites.longitude,
        sites.timezone,
        sites.is_active,
        count(DISTINCT checkpoints.id)::integer AS checkpoint_count,
        count(DISTINCT supervisor_sites.supervisor_id)::integer AS supervisor_count
      FROM sites
      LEFT JOIN checkpoints ON checkpoints.site_id = sites.id
      LEFT JOIN supervisor_sites ON supervisor_sites.site_id = sites.id
      GROUP BY sites.id
      ORDER BY sites.is_active DESC, sites.name
    `);
    return rows.map((site) => ({
      id: site.id,
      branchName: site.branch_name,
      name: site.name,
      address: site.address,
      latitude: site.latitude === null ? null : Number(site.latitude),
      longitude: site.longitude === null ? null : Number(site.longitude),
      timezone: site.timezone,
      isActive: site.is_active,
      checkpointCount: site.checkpoint_count,
      supervisorCount: site.supervisor_count,
    }));
  }

  async createSite(input: CreateSiteDto) {
    const siteId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO sites (
        id, tenant_id, branch_name, name, address, latitude, longitude, timezone
      ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7)`,
      [
        siteId,
        input.branchName,
        input.name,
        input.address,
        input.latitude ?? null,
        input.longitude ?? null,
        input.timezone ?? 'America/Santiago',
      ],
    );
    return { id: siteId };
  }

  async updateSite(siteId: string, input: UpdateSiteDto) {
    const fields: Array<[column: string, value: unknown]> = [];
    if (input.branchName !== undefined) fields.push(['branch_name', input.branchName.trim()]);
    if (input.name !== undefined) fields.push(['name', input.name.trim()]);
    if (input.address !== undefined) fields.push(['address', input.address.trim()]);
    if (input.latitude !== undefined) fields.push(['latitude', input.latitude]);
    if (input.longitude !== undefined) fields.push(['longitude', input.longitude]);
    if (input.timezone !== undefined) fields.push(['timezone', input.timezone]);
    if (!fields.length) throw new BadRequestException('Nada que actualizar');

    const sets = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const rows = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE sites SET ${sets} WHERE id = $1 RETURNING id`,
        [siteId, ...fields.map(([, value]) => value)],
      ),
    );
    if (!rows.length) throw new NotFoundException('Recinto no encontrado');
    return { id: siteId };
  }

  async setSiteActive(siteId: string, isActive: boolean) {
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE sites SET is_active = $2 WHERE id = $1 RETURNING id`,
        [siteId, isActive],
      ),
    );
    if (!result.length) throw new NotFoundException('Recinto no encontrado');
    return { id: siteId, isActive };
  }

  async listBusinessHours(siteId: string) {
    await this.ensureSite(siteId);
    const rows = await this.tenantContext.manager.query<Array<{
      weekday: number;
      opens_at: string;
      closes_at: string;
    }>>(
      `SELECT weekday, to_char(opens_at, 'HH24:MI') AS opens_at,
              to_char(closes_at, 'HH24:MI') AS closes_at
       FROM site_business_hours
       WHERE site_id = $1
       ORDER BY weekday`,
      [siteId],
    );
    return rows.map((row) => ({
      weekday: row.weekday,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    }));
  }

  async replaceBusinessHours(siteId: string, hours: SiteBusinessHourDto[]) {
    await this.ensureSite(siteId);
    const weekdays = hours.map((hour) => hour.weekday);
    if (new Set(weekdays).size !== weekdays.length) {
      throw new BadRequestException('Cada día puede tener un solo horario');
    }
    if (hours.some((hour) => hour.opensAt === hour.closesAt)) {
      throw new BadRequestException('La apertura y el cierre no pueden ser iguales');
    }
    await this.tenantContext.manager.query(
      `DELETE FROM site_business_hours WHERE site_id = $1`,
      [siteId],
    );
    for (const hour of hours) {
      await this.tenantContext.manager.query(
        `INSERT INTO site_business_hours
          (tenant_id, site_id, weekday, opens_at, closes_at)
         VALUES (app_tenant_id(), $1, $2, $3::time, $4::time)`,
        [siteId, hour.weekday, hour.opensAt, hour.closesAt],
      );
    }
    return this.listBusinessHours(siteId);
  }

  async listHolidays(siteId: string) {
    await this.ensureSite(siteId);
    const rows = await this.tenantContext.manager.query<Array<{
      holiday_date: string;
      name: string | null;
    }>>(
      `SELECT holiday_date::text, name
       FROM site_holidays
       WHERE site_id = $1
       ORDER BY holiday_date`,
      [siteId],
    );
    return rows.map((row) => ({ date: row.holiday_date, name: row.name }));
  }

  async replaceHolidays(siteId: string, holidays: SiteHolidayDto[]) {
    await this.ensureSite(siteId);
    const dates = holidays.map((holiday) => holiday.date);
    if (new Set(dates).size !== dates.length) {
      throw new BadRequestException('Cada feriado puede aparecer una sola vez');
    }
    for (const holiday of holidays) {
      const parsed = new Date(`${holiday.date}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== holiday.date) {
        throw new BadRequestException(`La fecha ${holiday.date} no es válida`);
      }
    }
    await this.tenantContext.manager.query(`DELETE FROM site_holidays WHERE site_id = $1`, [siteId]);
    for (const holiday of holidays) {
      await this.tenantContext.manager.query(
        `INSERT INTO site_holidays (tenant_id, site_id, holiday_date, name)
         VALUES (app_tenant_id(), $1, $2::date, $3)`,
        [siteId, holiday.date, holiday.name?.trim() || null],
      );
    }
    return this.listHolidays(siteId);
  }

  async setSupervisorSite(supervisorId: string, siteId: string, assigned: boolean) {
    if (assigned) {
      const result = await this.tenantContext.manager.query<Array<{ site_id: string }>>(
        `INSERT INTO supervisor_sites (tenant_id, supervisor_id, site_id)
         SELECT app_tenant_id(), membership.user_id, site.id
         FROM memberships membership
         JOIN sites site ON site.id = $2 AND site.is_active
         WHERE membership.user_id = $1
           AND membership.role_key = 'SUPERVISOR'
         ON CONFLICT DO NOTHING
         RETURNING site_id`,
        [supervisorId, siteId],
      );
      if (!result.length) {
        const existing = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
          `SELECT true AS present FROM supervisor_sites
           WHERE supervisor_id = $1 AND site_id = $2`,
          [supervisorId, siteId],
        );
        if (!existing.length) throw new NotFoundException('Supervisor o recinto no encontrado');
      }
    } else {
      await this.tenantContext.manager.query(
        `DELETE FROM supervisor_sites WHERE supervisor_id = $1 AND site_id = $2`,
        [supervisorId, siteId],
      );
    }
    return { supervisorId, siteId, assigned };
  }

  /** Devuelve el nombre porque el resumen de auditoria lo necesita. */
  private async ensureSite(siteId: string): Promise<{ id: string; name: string }> {
    const site = await this.tenantContext.manager.query<Array<{ id: string; name: string }>>(
      `SELECT id, name FROM sites WHERE id = $1`,
      [siteId],
    );
    const encontrado = site[0];
    if (!encontrado) throw new NotFoundException('Recinto no encontrado');
    return encontrado;
  }

  async listCheckpoints(siteId: string) {
    await this.ensureSite(siteId);
    const rows = await this.tenantContext.manager.query<CheckpointRow[]>(
      `SELECT id, site_id, name, description, suggested_order, kind,
              latitude, longitude, requires_photo, instructions, is_active
       FROM checkpoints
       WHERE site_id = $1
       ORDER BY suggested_order, name`,
      [siteId],
    );
    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      name: row.name,
      description: row.description,
      suggestedOrder: row.suggested_order,
      kind: row.kind,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      requiresPhoto: row.requires_photo,
      instructions: row.instructions,
      isActive: row.is_active,
    }));
  }

  async createCheckpoint(
    siteId: string,
    input: CreateCheckpointDto,
    contexto?: ContextoEscritura,
  ) {
    const recinto = await this.ensureSite(siteId);
    const checkpointId = randomUUID();
    // El alcance va PEGADO a la escritura, no solo en el pre-chequeo: por eso el
    // INSERT es `... SELECT ... WHERE`, que es la unica forma de que un llamador
    // futuro que se saltee `ensureAssignedSite` falle CERRADO en vez de crear el
    // punto en un recinto ajeno. Para el ADMIN el fragmento es vacio y la
    // sentencia se comporta igual que antes.
    const alcance = alcanceDelSupervisor(contexto?.supervisorId, '$2', 11);
    const creado = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO checkpoints (
        id, tenant_id, site_id, name, description, suggested_order, kind,
        latitude, longitude, requires_photo, instructions
      )
      SELECT $1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10
      WHERE EXISTS (SELECT 1 FROM sites s WHERE s.id = $2)${alcance.sql}
      RETURNING id`,
      [
        checkpointId,
        siteId,
        input.name,
        input.description ?? null,
        input.suggestedOrder ?? 0,
        input.kind ?? 'normal',
        input.latitude ?? null,
        input.longitude ?? null,
        input.requiresPhoto ?? null,
        input.instructions ?? null,
        ...alcance.params,
      ],
    );
    if (!creado.length) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
    let tagId: string | null = null;
    if (input.tagUid?.trim()) {
      tagId = randomUUID();
      try {
        await this.tenantContext.manager.query(
          `INSERT INTO tags (id, tenant_id, checkpoint_id, tech, uid)
           VALUES ($1, app_tenant_id(), $2, 'nfc', $3)`,
          [tagId, checkpointId, input.tagUid.trim()],
        );
      } catch (error) {
        if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
          throw new ConflictException('Esa etiqueta ya está registrada en otro punto');
        }
        throw error;
      }
    }
    await this.registrar(
      contexto,
      'punto.creado',
      'checkpoint',
      `Punto "${input.name}" creado en ${recinto.name}` +
        (tagId ? ' con etiqueta NFC vinculada en el alta' : ' sin etiqueta'),
      checkpointId,
    );
    return { id: checkpointId, tagId };
  }

  async importCheckpoints(
    siteId: string,
    checkpoints: ImportCheckpointRowDto[],
    contexto?: ContextoEscritura,
  ) {
    const recinto = await this.ensureSite(siteId);
    const tagUids = checkpoints
      .map((checkpoint) => checkpoint.tagUid?.trim().toLowerCase())
      .filter((uid): uid is string => Boolean(uid));
    if (new Set(tagUids).size !== tagUids.length) {
      throw new BadRequestException('El CSV repite una etiqueta NFC');
    }

    const imported: Array<{ id: string; tagId: string | null }> = [];
    for (const [index, checkpoint] of checkpoints.entries()) {
      const id = randomUUID();
      await this.tenantContext.manager.query(
        `INSERT INTO checkpoints (
          id, tenant_id, site_id, name, description, suggested_order, kind,
          latitude, longitude, requires_photo, instructions
        ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          siteId,
          checkpoint.name.trim(),
          checkpoint.description?.trim() || null,
          checkpoint.suggestedOrder ?? index + 1,
          checkpoint.kind ?? 'normal',
          checkpoint.latitude ?? null,
          checkpoint.longitude ?? null,
          checkpoint.requiresPhoto ?? null,
          checkpoint.instructions?.trim() || null,
        ],
      );
      let tagId: string | null = null;
      if (checkpoint.tagUid) {
        tagId = randomUUID();
        try {
          await this.tenantContext.manager.query(
            `INSERT INTO tags (id, tenant_id, checkpoint_id, tech, uid)
             VALUES ($1, app_tenant_id(), $2, 'nfc', $3)`,
            [tagId, id, checkpoint.tagUid.trim()],
          );
        } catch (error) {
          if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
            throw new ConflictException(
              `La etiqueta de la fila ${index + 2} ya está registrada en otro punto`,
            );
          }
          throw error;
        }
      }
      imported.push({ id, tagId });
    }
    // Una sola linea por importacion y no 500: la accion que se audita es la
    // carga masiva, y quinientas filas por CSV ahogarian el registro del tenant.
    await this.registrar(
      contexto,
      'punto.creado',
      'checkpoint',
      `${imported.length} puntos importados por CSV en ${recinto.name}` +
        ` (${imported.filter((p) => p.tagId).length} con etiqueta)`,
    );
    return { imported: imported.length, checkpoints: imported };
  }

  async updateCheckpoint(
    checkpointId: string,
    input: UpdateCheckpointDto,
    contexto?: ContextoEscritura,
  ) {
    const campos: Array<[columna: string, valor: unknown]> = [];
    if (input.name !== undefined) campos.push(['name', input.name]);
    if (input.description !== undefined) campos.push(['description', input.description]);
    if (input.kind !== undefined) campos.push(['kind', input.kind]);
    if (input.suggestedOrder !== undefined) campos.push(['suggested_order', input.suggestedOrder]);
    if (input.latitude !== undefined) campos.push(['latitude', input.latitude]);
    if (input.longitude !== undefined) campos.push(['longitude', input.longitude]);
    if (input.instructions !== undefined) campos.push(['instructions', input.instructions]);
    if (!campos.length) throw new BadRequestException('Nada que actualizar');

    const sets = campos.map(([columna], i) => `${columna} = $${i + 2}`).join(', ');
    const alcance = alcanceDelSupervisor(
      contexto?.supervisorId,
      'checkpoints.site_id',
      campos.length + 2,
    );
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE checkpoints SET ${sets} WHERE id = $1${alcance.sql} RETURNING id`,
        [checkpointId, ...campos.map(([, valor]) => valor), ...alcance.params],
      ),
    );
    if (!result.length) throw faltaLaFila(contexto, 'Punto de control no encontrado');
    // Mover un punto es mover la vara del anti-fraude: si el guardia marcaba
    // anomalia por distancia, cambiar la coordenada la apaga. Por eso el resumen
    // nombra las coordenadas en vez de decir "se modifico el punto".
    await this.registrar(
      contexto,
      'punto.modificado',
      'checkpoint',
      `Punto modificado: ${campos.map(([columna]) => columna).join(', ')}` +
        (campos.some(([columna]) => columna === 'latitude' || columna === 'longitude')
          ? ' — incluye COORDENADAS'
          : ''),
      checkpointId,
    );
    return { id: checkpointId };
  }

  async setCheckpointPhoto(
    checkpointId: string,
    requiresPhoto: boolean | null,
    contexto?: ContextoEscritura,
  ) {
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE checkpoints SET requires_photo = $2 WHERE id = $1 RETURNING id`,
        [checkpointId, requiresPhoto],
      ),
    );
    if (!result.length) throw new NotFoundException('Punto de control no encontrado');
    await this.registrar(
      contexto,
      'punto.modificado',
      'checkpoint',
      `Regla de FOTO del punto: ${
        requiresPhoto === null ? 'vuelve a heredar las reglas' : requiresPhoto ? 'siempre' : 'nunca'
      }`,
      checkpointId,
    );
    return { id: checkpointId, requiresPhoto };
  }

  async setCheckpointActive(
    checkpointId: string,
    isActive: boolean,
    contexto?: ContextoEscritura,
  ) {
    const alcance = alcanceDelSupervisor(contexto?.supervisorId, 'checkpoints.site_id', 3);
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE checkpoints SET is_active = $2 WHERE id = $1${alcance.sql} RETURNING id`,
        [checkpointId, isActive, ...alcance.params],
      ),
    );
    if (!result.length) throw faltaLaFila(contexto, 'Punto de control no encontrado');
    // Desactivar puntos achica el denominador de computeCompliance(): es una
    // operacion legitima y por eso queda escrita con todas sus letras.
    await this.registrar(
      contexto,
      'punto.modificado',
      'checkpoint',
      isActive
        ? 'Punto REACTIVADO: vuelve a contar para el cumplimiento'
        : 'Punto DADO DE BAJA: deja de contar para el cumplimiento',
      checkpointId,
    );
    return { id: checkpointId, isActive };
  }

  /**
   * Publico porque el camino del SUPERVISOR (#309) resuelve con esto el recinto
   * de un punto ANTES de comprobar el alcance: el 404 de "no existe" —que RLS ya
   * produjo si el punto es de otra empresa— tiene que salir antes que el 403 de
   * "existe pero no es tuyo", o el 403 confirmaria que el id existe.
   */
  async ensureCheckpoint(checkpointId: string): Promise<PuntoUbicado> {
    const checkpoint = await this.tenantContext.manager.query<PuntoUbicado[]>(
      `SELECT c.id, c.name, c.site_id, s.name AS site_name
       FROM checkpoints c JOIN sites s ON s.id = c.site_id
       WHERE c.id = $1`,
      [checkpointId],
    );
    const encontrado = checkpoint[0];
    if (!encontrado) throw new NotFoundException('Punto de control no encontrado');
    return encontrado;
  }

  /** El recinto de una etiqueta, por su punto. Dos saltos: tag -> checkpoint -> site. */
  async ensureTag(tagId: string): Promise<PuntoUbicado & { tag_id: string }> {
    const filas = await this.tenantContext.manager.query<Array<PuntoUbicado & { tag_id: string }>>(
      `SELECT t.id AS tag_id, c.id, c.name, c.site_id, s.name AS site_name
       FROM tags t
       JOIN checkpoints c ON c.id = t.checkpoint_id
       JOIN sites s ON s.id = c.site_id
       WHERE t.id = $1`,
      [tagId],
    );
    const encontrada = filas[0];
    if (!encontrada) throw new NotFoundException('Etiqueta activa no encontrada');
    return encontrada;
  }

  /**
   * El nombre con el que queda el actor en `audit_log`. Se guarda por id Y por
   * texto a proposito: si el usuario se elimina despues, la fila debe seguir
   * diciendo quien fue (ver 1724598000000-CreateAuditLog).
   */
  private async etiquetaDeActor(actorId: string): Promise<string> {
    const filas = await this.tenantContext.manager.query<Array<{ label: string }>>(
      `SELECT (given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
      [actorId],
    );
    return filas[0]?.label ?? 'usuario desconocido';
  }

  /**
   * Registra la accion como ULTIMA sentencia del metodo.
   *
   * `AuditService.record` se traga sus errores, pero eso NO desaborta la
   * transaccion de PostgreSQL (CLAUDE.md, cuarta trampa): si el INSERT revienta,
   * el commit del interceptor revienta despues y el punto recien creado se
   * pierde con un 500 mudo. Por eso los nombres de columna de audit_log se
   * verifican contra la migracion, no contra el mock.
   */
  private async registrar(
    contexto: ContextoEscritura | undefined,
    accion: 'punto.creado' | 'punto.modificado' | 'etiqueta.registrada' | 'etiqueta.retirada',
    entityType: 'checkpoint' | 'tag',
    resumen: string,
    entityId?: string,
  ): Promise<void> {
    if (!contexto) return;
    await this.audit.record({
      actorId: contexto.actorId,
      actorLabel: await this.etiquetaDeActor(contexto.actorId),
      action: accion,
      entityType,
      ...(entityId === undefined ? {} : { entityId }),
      summary: resumen,
    });
  }

  async listTags(checkpointId: string) {
    await this.ensureCheckpoint(checkpointId);
    const rows = await this.tenantContext.manager.query<TagRow[]>(
      `SELECT id, checkpoint_id, tech, uid, is_active, installed_at, replaced_at
       FROM tags
       WHERE checkpoint_id = $1
       ORDER BY installed_at DESC`,
      [checkpointId],
    );
    return rows.map((row) => ({
      id: row.id,
      checkpointId: row.checkpoint_id,
      tech: row.tech,
      uid: row.uid,
      active: row.is_active,
      installedAt: row.installed_at,
      replacedAt: row.replaced_at,
    }));
  }

  async registerTag(checkpointId: string, input: RegisterTagDto, contexto?: ContextoEscritura) {
    const punto = await this.ensureCheckpoint(checkpointId);
    const tech = input.tech ?? 'nfc';
    // Se normaliza a la forma que produce la app al leer el chip. Ver uid-nfc.ts:
    // sin esto, un UID pegado como `04:AA:BB:CC` se guarda con los dos puntos y
    // no coincide con ningun escaneo, nunca.
    const uid = normalizarUidDeEtiqueta(input.uid, tech);
    if (tech === 'nfc' && !uidNfcValido(uid)) {
      throw new BadRequestException(
        'El UID de una etiqueta NFC son 8, 14 o 20 caracteres hexadecimales. ' +
        'Revisa lo que copiaste del lector.',
      );
    }

    // Reemplazo con historial: si el punto ya tiene una etiqueta activa de esta
    // tecnologia, queda desactivada con su fecha. Nunca se borra una fila.
    //
    // Sin `filasDe`, `replaced[0]` era el ARREGLO de filas y `replaced[0].id`
    // undefined: `replacedTagId` salia null incluso cuando si hubo reemplazo, y
    // esa es justamente la trazabilidad de que etiqueta se retiro.
    //
    // El guardia de alcance va PEGADO a este UPDATE, que es la mitad
    // destructiva: sin el, el camino del SUPERVISOR podria dejar sin etiqueta
    // activa un punto ajeno aunque el alta siguiente fallara. Aca la tabla que
    // se escribe no tiene `site_id`, asi que el EXISTS salta tags -> checkpoints
    // -> supervisor_sites en vez de usar `alcanceDelSupervisor`.
    const alcance = contexto?.supervisorId
      ? {
          sql: ` AND EXISTS (SELECT 1 FROM checkpoints c
                   JOIN supervisor_sites ss ON ss.site_id = c.site_id
                   WHERE c.id = tags.checkpoint_id AND ss.supervisor_id = $3)`,
          params: [contexto.supervisorId],
        }
      : { sql: '', params: [] };
    const replaced = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE tags SET is_active = false, replaced_at = now()
         WHERE checkpoint_id = $1 AND tech = $2 AND is_active${alcance.sql}
         RETURNING id`,
        [checkpointId, tech, ...alcance.params],
      ),
    );

    const tagId = randomUUID();
    try {
      await this.tenantContext.manager.query(
        `INSERT INTO tags (id, tenant_id, checkpoint_id, tech, uid)
         VALUES ($1, app_tenant_id(), $2, $3, $4)`,
        [tagId, checkpointId, tech, uid],
      );
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
        // Indice global tags_active_uid_uniq: el UID ya esta activo en algun
        // punto — de este tenant o de otro. No se revela cual.
        throw new ConflictException('Esa etiqueta ya está registrada en otro punto');
      }
      throw error;
    }
    // El REEMPLAZO es la señal, no el alta: quien re-vincula una etiqueta puede
    // simular presencia (pega una calcomanía nueva en la caseta y el punto lejano
    // queda "visitado"). Por eso el resumen nombra la etiqueta que se retiro.
    // El UID no es dato de una persona y ya es visible en GET .../tags para la
    // misma audiencia; nombres o ubicaciones de guardias no van, nunca.
    await this.registrar(
      contexto,
      'etiqueta.registrada',
      'tag',
      `Etiqueta ${tech.toUpperCase()} ${uid} vinculada a "${punto.name}" (${punto.site_name})` +
        (replaced[0]?.id ? ` — REEMPLAZA a la etiqueta ${replaced[0].id}` : ''),
      tagId,
    );
    return { id: tagId, checkpointId, tech, uid, replacedTagId: replaced[0]?.id ?? null };
  }

  async retireTag(tagId: string, contexto?: ContextoEscritura) {
    // Solo el camino del SUPERVISOR necesita saber a que punto pertenece, para
    // el resumen y para el 403; el del ADMIN opera sobre el tenant entero.
    const punto = contexto ? await this.ensureTag(tagId) : null;
    const alcance = contexto?.supervisorId
      ? {
          sql: ` AND EXISTS (SELECT 1 FROM checkpoints c
                   JOIN supervisor_sites ss ON ss.site_id = c.site_id
                   WHERE c.id = tags.checkpoint_id AND ss.supervisor_id = $2)`,
          params: [contexto.supervisorId],
        }
      : { sql: '', params: [] };
    const result = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `UPDATE tags SET is_active = false, replaced_at = now()
         WHERE id = $1 AND is_active${alcance.sql}
         RETURNING id`,
        [tagId, ...alcance.params],
      ),
    );
    if (!result.length) throw faltaLaFila(contexto, 'Etiqueta activa no encontrada');
    await this.registrar(
      contexto,
      'etiqueta.retirada',
      'tag',
      punto
        ? `Etiqueta retirada de "${punto.name}" (${punto.site_name})`
        : 'Etiqueta retirada',
      tagId,
    );
    return { id: tagId, active: false };
  }

  async resolveTag(uid: string) {
    // RLS limita al tenant de la sesion: la etiqueta de otra empresa
    // simplemente no resuelve, que es el comportamiento del contrato.
    const rows = await this.tenantContext.manager.query<Array<{
      tag_id: string;
      tech: 'nfc' | 'qr';
      checkpoint_id: string;
      checkpoint_name: string;
      kind: 'normal' | 'acceso_critico';
      requires_photo: boolean | null;
      instructions: string | null;
      site_id: string;
      site_name: string;
    }>>(
      `SELECT tag.id AS tag_id, tag.tech,
              checkpoint.id AS checkpoint_id, checkpoint.name AS checkpoint_name,
              checkpoint.kind, checkpoint.requires_photo, checkpoint.instructions,
              site.id AS site_id, site.name AS site_name
       FROM tags tag
       JOIN checkpoints checkpoint
         ON checkpoint.id = tag.checkpoint_id AND checkpoint.is_active
       JOIN sites site ON site.id = checkpoint.site_id AND site.is_active
       WHERE tag.uid IN ($1, $2) AND tag.is_active`,
      // Dos formas porque aqui no se sabe la tecnologia: el texto tal cual (un
      // QR, `VXQ-...`) y el mismo texto normalizado como UID de NFC. Asi el
      // instalador puede pegar `04:aa:bb:cc` o `04AABBCC` y resuelve igual.
      [uid.trim(), normalizarUidNfc(uid.trim())],
    );
    const [row] = rows;
    if (!row) throw new NotFoundException('La etiqueta no resuelve a ningún punto');
    return {
      tagId: row.tag_id,
      tech: row.tech,
      checkpoint: {
        id: row.checkpoint_id,
        name: row.checkpoint_name,
        kind: row.kind,
        requiresPhoto: row.requires_photo,
        instructions: row.instructions,
      },
      site: { id: row.site_id, name: row.site_name },
    };
  }
}
