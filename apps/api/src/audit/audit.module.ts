import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { AuditController } from './audit.controller';
import { AuditWriterModule } from './audit-writer.module';
import { StatsService } from './stats.service';

@Module({
  imports: [DatabaseModule, RulesModule, AuditWriterModule],
  controllers: [AuditController],
  providers: [StatsService],
  // AuditService lo consumen los modulos que registran acciones sensibles.
  exports: [AuditWriterModule],
})
export class AuditModule {}
