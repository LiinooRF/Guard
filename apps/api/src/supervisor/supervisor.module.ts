import { Module } from '@nestjs/common';

import { AuditWriterModule } from '../audit/audit-writer.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorController } from './supervisor.controller';
import { SupervisorService } from './supervisor.service';

@Module({
  // AuditWriterModule provee AuditService: `SupervisorService` lo usa para
  // dejar registro de quien retira un turno del calendario. Sin este import,
  // Nest no puede construir el servicio y la API no levanta.
  imports: [DatabaseModule, RulesModule, AuditWriterModule],
  controllers: [SupervisorController],
  providers: [SupervisorService],
  exports: [SupervisorService],
})
export class SupervisorModule {}
