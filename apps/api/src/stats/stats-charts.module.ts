import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { StatsChartsController } from './stats-charts.controller';
import { StatsChartsService } from './stats-charts.service';

/**
 * DatabaseModule: el servicio inyecta TenantContextService (la transaccion con
 * `app.tenant_id` puesto).
 * RulesModule: el umbral de cumplimiento es configurable por tenant, no una
 * constante.
 * SupervisorModule: `ensureAssignedSite` es el control de acceso a recintos del
 * SUPERVISOR y se reusa, no se reimplementa.
 */
@Module({
  imports: [DatabaseModule, RulesModule, SupervisorModule],
  controllers: [StatsChartsController],
  providers: [StatsChartsService],
})
export class StatsChartsModule {}
