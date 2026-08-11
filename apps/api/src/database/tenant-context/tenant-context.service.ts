import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import type { EntityManager, QueryRunner } from 'typeorm';

type AfterCommitCallback = () => void | Promise<void>;

interface TenantExecutionContext {
  queryRunner: QueryRunner;
  /**
   * Tenant ya autenticado y enlazado al mismo QueryRunner con SET LOCAL.
   * Nunca se obtiene de DTOs, query params ni de RulesService.
   */
  tenantId: string | null;
  afterCommit: AfterCommitCallback[];
}

@Injectable()
export class TenantContextService {
  private readonly logger = new Logger(TenantContextService.name);
  private readonly storage = new AsyncLocalStorage<TenantExecutionContext>();
  private readonly pendingByRunner = new WeakMap<QueryRunner, TenantExecutionContext>();

  run<T>(queryRunner: QueryRunner, operation: () => Promise<T>): Promise<T>;
  run<T>(
    queryRunner: QueryRunner,
    authenticatedTenantId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  run<T>(
    queryRunner: QueryRunner,
    tenantOrOperation: string | (() => Promise<T>),
    maybeOperation?: () => Promise<T>,
  ): Promise<T> {
    const authenticatedTenantId =
      typeof tenantOrOperation === 'string' ? tenantOrOperation : null;
    const operation =
      typeof tenantOrOperation === 'function' ? tenantOrOperation : maybeOperation;

    if (!operation) {
      throw new Error('Falta la operacion del contexto tenant');
    }
    if (authenticatedTenantId !== null && !isUUID(authenticatedTenantId)) {
      throw new Error('El tenant autenticado del contexto no es un UUID valido');
    }

    const context: TenantExecutionContext = {
      queryRunner,
      tenantId: authenticatedTenantId,
      afterCommit: [],
    };
    this.pendingByRunner.set(queryRunner, context);
    return this.storage.run(context, operation);
  }

  /** Tenant autenticado del contexto servidor; null fuera de una transaccion enlazada. */
  get tenantId(): string | null {
    return this.storage.getStore()?.tenantId ?? null;
  }

  /**
   * Registra trabajo que solo puede ocurrir cuando PostgreSQL ya confirmo.
   * Devuelve false fuera de un contexto para que una cache auxiliar nunca haga
   * fallar una escritura valida ni se ejecute prematuramente.
   */
  afterCommit(callback: AfterCommitCallback): boolean {
    const context = this.storage.getStore();
    if (!context) return false;
    context.afterCommit.push(callback);
    return true;
  }

  /**
   * Se llama inmediatamente DESPUES de commitTransaction(). Los callbacks se
   * aislan entre si y nunca convierten un commit confirmado en un falso 500.
   */
  async transactionCommitted(queryRunner: QueryRunner): Promise<void> {
    const context = this.pendingByRunner.get(queryRunner);
    this.pendingByRunner.delete(queryRunner);
    if (!context) return;

    let failures = 0;
    for (const callback of context.afterCommit) {
      try {
        await callback();
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      this.logger.warn(
        JSON.stringify({ event: 'tenant_after_commit_failure', failures }),
      );
    }
  }

  /** Un rollback descarta toda invalidacion pendiente. */
  transactionRolledBack(queryRunner: QueryRunner): void {
    this.pendingByRunner.delete(queryRunner);
  }

  get manager(): EntityManager {
    const queryRunner = this.storage.getStore()?.queryRunner;

    if (!queryRunner) {
      throw new Error('No existe una transaccion asociada al contexto tenant actual');
    }

    return queryRunner.manager;
  }
}
