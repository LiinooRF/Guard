import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { StatsService } from './stats.service';

@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [AuditController],
  providers: [AuditService, StatsService],
  // AuditService lo consumen los modulos que registran acciones sensibles.
  exports: [AuditService],
})
export class AuditModule {}
