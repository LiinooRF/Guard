import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

/**
 * DatabaseModule es obligatorio: SchedulingService inyecta TenantContextService.
 *
 * SupervisorModule entra por dos cosas que NO se reimplementan aca: el sorteo de
 * orden anti-predictibilidad y la verificacion de que el supervisor tiene el
 * recinto asignado. Duplicar la segunda seria duplicar un control de acceso, que
 * es la clase de codigo que se arregla en un lugar y se olvida en el otro.
 * Requiere que SupervisorModule exporte SupervisorService (ver INTEGRACION.md).
 *
 * Se exporta el servicio para que el futuro worker de BullMQ (#62) llame a
 * generateForDate sin pasar por HTTP.
 */
@Module({
  imports: [DatabaseModule, SupervisorModule, RulesModule, AuditModule],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
