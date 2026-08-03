import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminModule } from './admin/admin.module';
import { validateEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GuardModule } from './guard/guard.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { EvidenceModule } from './evidence/evidence.module';
import { PlatformModule } from './platform/platform.module';
import { TenantDataModule } from './platform-data/tenant-data.module';
import { ReportsModule } from './reports/reports.module';
import { RulesModule } from './rules/rules.module';
import { SupervisorModule } from './supervisor/supervisor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // El .env vive en la raiz del monorepo, compartido por api y web.
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
    DatabaseModule,
    AdminModule,
    DashboardModule,
    AuthModule,
    GuardModule,
    MailModule,
    EvidenceModule,
    PlatformModule,
    TenantDataModule,
    ReportsModule,
    RulesModule,
    SupervisorModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
