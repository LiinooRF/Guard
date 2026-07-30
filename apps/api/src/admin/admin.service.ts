import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { CreateSiteDto } from './dto/create-site.dto';
import type { CreateTenantUserDto } from './dto/create-user.dto';

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

@Injectable()
export class AdminService {
  constructor(private readonly tenantContext: TenantContextService) {}

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

  async createUser(input: CreateTenantUserDto) {
    if (!input.email && !input.username) {
      throw new BadRequestException('Debes indicar correo o nombre de usuario');
    }
    const userId = randomUUID();
    const passwordHash = await hash(input.password, {
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
    return { id: userId };
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
    return { id: userId, isActive };
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
}
