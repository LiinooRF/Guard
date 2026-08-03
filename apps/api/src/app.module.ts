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
import { PlatformModule } from './platform/platform.module';
import { RulesController } from './rules/rules.controller';
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
    PlatformModule,
    SupervisorModule,
  ],
  controllers: [HealthController, RulesController],
})
export class AppModule {}
