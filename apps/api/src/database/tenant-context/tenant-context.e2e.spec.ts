import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';

const appDatabaseUrl = process.env.DATABASE_APP_TEST_URL;
const describeDatabase = appDatabaseUrl ? describe : describe.skip;
const USER_ID = 'a0000000-0000-4000-8000-000000000002';
const TENANTS = [
  ['a0000000-0000-4000-8000-000000000001', 'demo-andina'],
  ['b0000000-0000-4000-8000-000000000001', 'demo-pacifico'],
] as const;

@Controller('isolation-probe')
class IsolationProbeController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get()
  async listVisibleTenants(): Promise<string[]> {
    const rows = await this.tenantContext.manager.query(`SELECT slug FROM tenants ORDER BY slug`);
    return (rows as Array<{ slug: string }>).map((row) => row.slug);
  }
}

describeDatabase('contexto tenant HTTP (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url: appDatabaseUrl, entities: [] });
    await dataSource.initialize();
    const testingModule = await Test.createTestingModule({
      controllers: [IsolationProbeController],
      providers: [TenantContextService],
    }).compile();
    app = testingModule.createNestApplication();

    const tenantContext = testingModule.get(TenantContextService);
    app.use((req: Request & { user?: object }, _res: Response, next: NextFunction) => {
      const tenantId = req.header('x-test-tenant-id');
      if (tenantId) req.user = { sub: USER_ID, tenant_id: tenantId };
      next();
    });
    app.useGlobalInterceptors(
      new TenantContextInterceptor(dataSource, tenantContext, new Reflector()),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  it('50 requests paralelos sólo reciben el tenant de su JWT simulado', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const [tenantId] = TENANTS[index % TENANTS.length]!;
        return request(app.getHttpServer())
          .get('/isolation-probe')
          .set('x-test-tenant-id', tenantId)
          .expect(200);
      }),
    );

    responses.forEach((response, index) => {
      expect(response.body).toEqual([TENANTS[index % TENANTS.length]![1]]);
    });
  });

  it('un endpoint sin tenant devuelve 401 y nunca consulta datos', async () => {
    await request(app.getHttpServer()).get('/isolation-probe').expect(401);
  });
});
