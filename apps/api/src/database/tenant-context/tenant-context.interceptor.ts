import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
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
import { SupportAccessService } from '../../platform-data/support-access.service';
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
    private readonly support: SupportAccessService,
  ) {}

  async intercept(
    executionContext: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
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

    if (!userId || !isUUID(userId)) {
      throw new UnauthorizedException('Se requiere una sesion valida');
    }

    // Acceso de soporte (#109): el SUPERADMIN no tiene tenant en su sesion, pero
    // puede entrar a UNA empresa presentando una ventana de soporte vigente que
    // el mismo abrio con motivo y vencimiento. No es un bypass: RLS sigue
    // activo, y la politica lo deja ver solo ese tenant a traves de
    // app_has_audited_support_access().
    // headers[...] y no header(...): funciona igual con Express y con un
    // objeto plano, que es como lo construyen los tests.
    const supportAccessId = request.headers?.['x-support-access-id'];
    if (!tenantId && supportAccessId) {
      if (typeof supportAccessId !== 'string' || !isUUID(supportAccessId)) {
        throw new UnauthorizedException('El identificador de acceso de soporte no es valido');
      }
      const soporteTenant = await this.support.resolve(supportAccessId, userId);
      if (!soporteTenant) {
        throw new ForbiddenException('El acceso de soporte no existe, ya vencio o fue cerrado');
      }
      return from(
        this.executeInTenantTransaction(userId, soporteTenant, next, supportAccessId),
      );
    }

    if (!tenantId || !isUUID(tenantId)) {
      throw new UnauthorizedException('Se requiere una sesion con tenant valido');
    }

    return from(this.executeInTenantTransaction(userId, tenantId, next));
  }

  private async executeInTenantTransaction(
    userId: string,
    tenantId: string,
    next: CallHandler,
    supportAccessId?: string,
  ): Promise<unknown> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // El tercer valor es lo que activa app_has_audited_support_access() en las
      // politicas RLS. Sin acceso de soporte va vacio y la funcion devuelve
      // false, que es el comportamiento normal.
      await queryRunner.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', $2, true),
          set_config('app.support_access_id', $3, true)`,
        [tenantId, userId, supportAccessId ?? ''],
      );

      // El mismo UUID ya puesto con SET LOCAL entra al AsyncLocalStorage. No
      // existe un tenant separado suministrado por RulesService o por el cliente.
      // Soporte auditado conserva el camino fail-safe: opera bajo RLS, pero no
      // comparte cache con una sesion tenant ordinaria.
      const operation = () => lastValueFrom(next.handle());
      const result = supportAccessId
        ? await this.context.run(queryRunner, operation)
        : await this.context.run(queryRunner, tenantId, operation);
      await queryRunner.commitTransaction();
      await this.context.transactionCommitted(queryRunner);
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.context.transactionRolledBack(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
