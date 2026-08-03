import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

// DatabaseModule es obligatorio: ReportsService inyecta TenantContextService.
// Se exporta ReportsService para que el cierre de ronda (GuardService) adjunte
// el informe al correo del umbral (#17).
@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
