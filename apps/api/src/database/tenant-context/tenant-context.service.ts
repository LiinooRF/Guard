import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager, QueryRunner } from 'typeorm';

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<QueryRunner>();

  run<T>(queryRunner: QueryRunner, operation: () => Promise<T>): Promise<T> {
    return this.storage.run(queryRunner, operation);
  }

  get manager(): EntityManager {
    const queryRunner = this.storage.getStore();

    if (!queryRunner) {
      throw new Error('No existe una transaccion asociada al contexto tenant actual');
    }

    return queryRunner.manager;
  }
}
