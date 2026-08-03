import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestLogContext {
  requestId: string;
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<RequestLogContext>();

export const requestLogContext = {
  run<T>(requestId: string, callback: () => T): T {
    return storage.run({ requestId, tenantId: null }, callback);
  },
  setTenant(tenantId: string | null): void {
    const context = storage.getStore();
    if (context) context.tenantId = tenantId;
  },
  current(): RequestLogContext {
    return storage.getStore() ?? { requestId: 'system', tenantId: null };
  },
};
