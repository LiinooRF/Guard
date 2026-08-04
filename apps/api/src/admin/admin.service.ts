import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';

import { AuthService } from '../auth/auth.service';
import { createAuthActionToken } from '../auth/auth-action-token';
import { MailService } from '../auth/mail.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import type { CreateSiteDto } from './dto/create-site.dto';
import type { CreateTenantUserDto, UpdateTenantUserDto } from './dto/create-user.dto';
import type { RegisterTagDto } from './dto/register-tag.dto';
import type { UpdateAuthPolicyDto } from './dto/update-auth-policy.dto';
import type { UpdateCheckpointDto } from './dto/update-checkpoint.dto';

interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  given_name: string;
  family_name: string;
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

@Injectable()
export class AdminService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
  ) {}

  async listUsers() {
    const rows = await this.tenantContext.manager.query<UserRow[]>(`
      SELECT
        users.id,
        users.email,
        users.username,
        users.given_name,
        users.family_name,
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
      if (error instanceof QueryFailedError && error.driverError?.code === 'P0001'
        && /límite de usuarios/i.test(String(error.driverError?.message))) {
        throw new ConflictException(String(error.driverError.message));
      }
      throw error;
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
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
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
      isActive: site.is_active,
      checkpointCount: site.checkpoint_count,
      supervisorCount: site.supervisor_count,
    }));
  }

  async createSite(input: CreateSiteDto) {
    const siteId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO sites (
        id, tenant_id, branch_name, name, address, latitude, longitude
      ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6)`,
      [
        siteId,
        input.branchName,
        input.name,
        input.address,
        input.latitude ?? null,
        input.longitude ?? null,
      ],
    );
    return { id: siteId };
  }

  async setSiteActive(siteId: string, isActive: boolean) {
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE sites SET is_active = $2 WHERE id = $1 RETURNING id`,
      [siteId, isActive],
    );
    if (!result.length) throw new NotFoundException('Recinto no encontrado');
    return { id: siteId, isActive };
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

  private async ensureSite(siteId: string) {
    const site = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM sites WHERE id = $1`,
      [siteId],
    );
    if (!site.length) throw new NotFoundException('Recinto no encontrado');
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

  async createCheckpoint(siteId: string, input: CreateCheckpointDto) {
    await this.ensureSite(siteId);
    const checkpointId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO checkpoints (
        id, tenant_id, site_id, name, description, suggested_order, kind,
        latitude, longitude, requires_photo, instructions
      ) VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
      ],
    );
    return { id: checkpointId };
  }

  async updateCheckpoint(checkpointId: string, input: UpdateCheckpointDto) {
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
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE checkpoints SET ${sets} WHERE id = $1 RETURNING id`,
      [checkpointId, ...campos.map(([, valor]) => valor)],
    );
    if (!result.length) throw new NotFoundException('Punto de control no encontrado');
    return { id: checkpointId };
  }

  async setCheckpointPhoto(checkpointId: string, requiresPhoto: boolean | null) {
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE checkpoints SET requires_photo = $2 WHERE id = $1 RETURNING id`,
      [checkpointId, requiresPhoto],
    );
    if (!result.length) throw new NotFoundException('Punto de control no encontrado');
    return { id: checkpointId, requiresPhoto };
  }

  async setCheckpointActive(checkpointId: string, isActive: boolean) {
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE checkpoints SET is_active = $2 WHERE id = $1 RETURNING id`,
      [checkpointId, isActive],
    );
    if (!result.length) throw new NotFoundException('Punto de control no encontrado');
    return { id: checkpointId, isActive };
  }

  private async ensureCheckpoint(checkpointId: string) {
    const checkpoint = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM checkpoints WHERE id = $1`,
      [checkpointId],
    );
    if (!checkpoint.length) throw new NotFoundException('Punto de control no encontrado');
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

  async registerTag(checkpointId: string, input: RegisterTagDto) {
    await this.ensureCheckpoint(checkpointId);
    const uid = input.uid.trim();
    const tech = input.tech ?? 'nfc';

    // Reemplazo con historial: si el punto ya tiene una etiqueta activa de esta
    // tecnologia, queda desactivada con su fecha. Nunca se borra una fila.
    const replaced = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE tags SET is_active = false, replaced_at = now()
       WHERE checkpoint_id = $1 AND tech = $2 AND is_active
       RETURNING id`,
      [checkpointId, tech],
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
    return { id: tagId, checkpointId, tech, uid, replacedTagId: replaced[0]?.id ?? null };
  }

  async retireTag(tagId: string) {
    const result = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `UPDATE tags SET is_active = false, replaced_at = now()
       WHERE id = $1 AND is_active
       RETURNING id`,
      [tagId],
    );
    if (!result.length) throw new NotFoundException('Etiqueta activa no encontrada');
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
       WHERE tag.uid = $1 AND tag.is_active`,
      [uid.trim()],
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
