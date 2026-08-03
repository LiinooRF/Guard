import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { DataSource } from 'typeorm';

import {
  SKIP_TENANT_CONTEXT,
} from './skip-tenant-context.decorator';
import { TenantContextService } from './tenant-context.service';

interface AuthenticatedRequest extends Request {
  user?: {
    sub?: string;
    tenant_id?: string;
  };
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly dataSource: DataSource,
    private readonly context: TenantContextService,
    private readonly reflector: Reflector,
  ) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CONTEXT, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.sub;
    const tenantId = request.user?.tenant_id;

    if (!userId || !tenantId || !isUUID(userId) || !isUUID(tenantId)) {
      throw new UnauthorizedException('Se requiere una sesion con tenant valido');
    }

    return from(this.executeInTenantTransaction(userId, tenantId, next));
  }

  private async executeInTenantTransaction(
    userId: string,
    tenantId: string,
    next: CallHandler,
  ): Promise<unknown> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', $2, true)`,
        [tenantId, userId],
      );

      const result = await this.context.run(queryRunner, () => lastValueFrom(next.handle()));
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
