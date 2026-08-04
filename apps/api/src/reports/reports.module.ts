import { Module } from '@nestjs/common';

import { BrandingModule } from '../branding/branding.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { PatrolReportService } from './patrol-report.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

// DatabaseModule es obligatorio: los servicios inyectan TenantContextService.
// BrandingModule provee la marca del tenant que se estampa en los informes
// (#117, #118): sin el, el PDF saldria con el nombre legal y sin logo.
//
// PatrolReportService se exporta para el envio automatico al cierre de ronda
// (#86), que lo llama desde un worker de BullMQ y no desde un controlador.
@Module({
  imports: [DatabaseModule, RulesModule, BrandingModule],
  controllers: [ReportsController],
  providers: [ReportsService, PatrolReportService],
  exports: [ReportsService, PatrolReportService],
})
export class ReportsModule {}
