import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';

import type { CreateTenantDto } from './dto/create-tenant.dto';

interface TenantRow {
  id: string;
  slug: string;
  legal_name: string;
  display_name: string;
  status: 'active' | 'suspended';
  plan_key: string;
  plan_name: string;
  user_limit: number;
  site_limit: number;
  site_count: number;
  user_count: number;
  monthly_patrol_count: number;
  last_patrol_at: Date | null;
  created_at: Date;
}

@Injectable()
export class PlatformService {
  constructor(private readonly dataSource: DataSource) {}

  async listTenants(actorId: string) {
    const rows = await this.withPlatformActor(actorId, (manager) =>
      manager.query<TenantRow[]>(`SELECT * FROM platform_list_tenants($1)`, [actorId]),
    );
    return rows.map((tenant) => ({
      id: tenant.id,
      slug: tenant.slug,
      legalName: tenant.legal_name,
      displayName: tenant.display_name,
      status: tenant.status,
      planKey: tenant.plan_key,
      planName: tenant.plan_name,
      userLimit: tenant.user_limit,
      siteLimit: tenant.site_limit,
      siteCount: tenant.site_count,
      userCount: tenant.user_count,
      monthlyPatrolCount: tenant.monthly_patrol_count,
      lastPatrolAt: tenant.last_patrol_at,
      createdAt: tenant.created_at,
    }));
  }

  async createTenant(actorId: string, input: CreateTenantDto) {
    const tenantId = randomUUID();
    const adminId = randomUUID();
    const passwordHash = await hash(input.adminPassword, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    try {
      await this.withPlatformActor(actorId, async (manager) => {
        await manager.query(
          `SELECT platform_create_tenant(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )`,
          [
            actorId,
            tenantId,
            input.slug,
            input.legalName,
            input.displayName,
            input.planKey,
            adminId,
            input.adminEmail.toLowerCase(),
            passwordHash,
            input.adminGivenName,
            input.adminFamilyName,
          ],
        );
      });
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
        throw new ConflictException('El slug o correo ya está registrado');
      }
      throw error;
    }

    return { id: tenantId, adminId };
  }

  async setTenantStatus(
    actorId: string,
    tenantId: string,
    status: 'active' | 'suspended',
  ) {
    try {
      await this.withPlatformActor(actorId, (manager) =>
        manager.query(`SELECT platform_set_tenant_status($1, $2, $3)`, [
          actorId,
          tenantId,
          status,
        ]),
      );
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === 'P0002') {
        throw new NotFoundException('Empresa no encontrada');
      }
      throw error;
    }
    return { id: tenantId, status };
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
