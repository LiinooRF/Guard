import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { BrandingModule } from './branding/branding.module';
import { ChecklistsModule } from './checklists/checklists.module';
import { EventsStreamModule } from './events-stream/events-stream.module';
import { validateEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GuardModule } from './guard/guard.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { EscalationModule } from './escalation/escalation.module';
import { EvidenceModule } from './evidence/evidence.module';
import { GeoModule } from './geo/geo.module';
import { PlatformModule } from './platform/platform.module';
import { PlatformOpsModule } from './platform-ops/platform-ops.module';
import { PushModule } from './push/push.module';
import { QrModule } from './qr/qr.module';
import { TenantDataModule } from './platform-data/tenant-data.module';
import { ReportsModule } from './reports/reports.module';
import { AlertasRondaModule } from './escalation/alertas-ronda.module';
import { ConsentModule } from './consent/consent.module';
import { FeatureFlagsModule } from './rules/feature-flags.module';
import { EnvioInformeModule } from './reports/envio-informe.module';
import { ConfigAuditModule } from './audit/config-audit.module';
import { PlantillasCorreoModule } from './mail/plantillas-correo.module';
import { RegistroEnviosModule } from './mail/registro-envios.module';
import { CrashReportingModule } from './observability/crash-reporting.module';
import { ExcelExportModule } from './reports/excel-export.module';
import { RulesModule } from './rules/rules.module';
import { StatsChartsModule } from './stats/stats-charts.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { SyncModule } from './sync/sync.module';

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
    AuditModule,
    BrandingModule,
    ChecklistsModule,
    EventsStreamModule,
    DashboardModule,
    AuthModule,
    GuardModule,
    MailModule,
    EscalationModule,
    EvidenceModule,
    GeoModule,
    PlatformModule,
    PlatformOpsModule,
    PushModule,
    QrModule,
    TenantDataModule,
    ReportsModule,
    RulesModule,
    ExcelExportModule,
    CrashReportingModule,
    RegistroEnviosModule,
    PlantillasCorreoModule,
    ConfigAuditModule,
    EnvioInformeModule,
    FeatureFlagsModule,
    ConsentModule,
    AlertasRondaModule,
    StatsChartsModule,
    SchedulingModule,
    SupervisorModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
