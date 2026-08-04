import { Logger, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseModule } from '../database/database.module';
import { FeatureFlagsModule } from '../rules/feature-flags.module';
import { RulesModule } from '../rules/rules.module';
import { CRASH_REPORTER } from './crash-event';
import { CRASH_REPORTING_CONFIG, loadCrashReportingConfig } from './crash-reporting.config';
import { CrashReportingInterceptor } from './crash-reporting.interceptor';
import { CrashReportingService } from './crash-reporting.service';
import { CrashReportsController } from './crash-reports.controller';
import { crearCrashReporter } from './sentry-crash-reporter';

/**
 * Reporte de caidas (#27). Opcional: con `CRASH_REPORT_DRIVER=off` —el
 * default— este modulo se carga, no manda nada a ningun tercero y no agrega
 * trabajo por request.
 *
 * DEPENDENCIAS:
 * - DatabaseModule: TenantContextService, para escribir bajo el contexto RLS.
 * - RulesModule: la retencion sale de la cascada de reglas, no del codigo.
 * - FeatureFlagsModule: exporta FeatureFlagsInterceptor, que es lo que hace que
 *   el controlador desaparezca (404) cuando la empresa no tiene el modulo.
 *
 * El interceptor global se registra ACA y no en app.module.ts a proposito: Nest
 * aplica los APP_INTERCEPTOR declarados en cualquier modulo a toda la
 * aplicacion, asi que integrar esto es agregar UNA linea de import y nada mas.
 */
@Module({
  imports: [DatabaseModule, RulesModule, FeatureFlagsModule],
  controllers: [CrashReportsController],
  providers: [
    {
      provide: CRASH_REPORTING_CONFIG,
      useFactory: () => {
        const config = loadCrashReportingConfig();
        // Sin el DSN ni la clave en el log: solo si esta prendido y en que
        // ambiente. Es lo unico que hace falta para saber si quedo bien.
        new Logger('CrashReporting').log(
          JSON.stringify({
            event: 'crash_reporting_configurado',
            driver: config.driver,
            environment: config.environment,
            release: config.release,
          }),
        );
        return config;
      },
    },
    {
      provide: CRASH_REPORTER,
      useFactory: crearCrashReporter,
      inject: [CRASH_REPORTING_CONFIG],
    },
    CrashReportingService,
    {
      provide: APP_INTERCEPTOR,
      useClass: CrashReportingInterceptor,
    },
  ],
  exports: [CrashReportingService],
})
export class CrashReportingModule {}
