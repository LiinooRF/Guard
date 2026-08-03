import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SupportAccessService } from '../platform-data/support-access.service';
import { DATABASE_ENTITIES } from './data-source';
import { TenantContextInterceptor } from './tenant-context/tenant-context.interceptor';
import { TenantContextService } from './tenant-context/tenant-context.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: DATABASE_ENTITIES,
        synchronize: false,
        migrationsRun: false,
        logging: false,
        invalidWhereValuesBehavior: {
          null: 'throw' as const,
          undefined: 'throw' as const,
        },
      }),
    }),
  ],
  providers: [
    TenantContextService,
    SupportAccessService,
    Reflector,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    },
  ],
  exports: [TenantContextService, SupportAccessService],
})
export class DatabaseModule {}
