import { Module } from '@nestjs/common';

import { BrandingModule } from '../branding/branding.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { ExcelExportController } from './excel-export.controller';
import { ExcelExportService } from './excel-export.service';

/**
 * Exportacion a Excel (#136). Modulo propio y no un provider mas de
 * ReportsModule: asi el PDF y la planilla no se arrastran entre si, y este
 * modulo puede quedar detras de un feature flag de plan sin tocar los informes.
 *
 * DatabaseModule: TenantContextService, la transaccion con `app.tenant_id`.
 * RulesModule: el tope de filas es configurable por tenant, no una constante.
 * BrandingModule: el color de la franja de titulos es el del tenant.
 * SupervisorModule: `ensureAssignedSite` es el control de acceso a recintos del
 * SUPERVISOR y se reusa, no se reimplementa.
 *
 * Se exporta el servicio porque el envio automatico de informes (#86) es el
 * proximo candidato a adjuntar la planilla.
 */
@Module({
  imports: [DatabaseModule, RulesModule, BrandingModule, SupervisorModule],
  controllers: [ExcelExportController],
  providers: [ExcelExportService],
  exports: [ExcelExportService],
})
export class ExcelExportModule {}
