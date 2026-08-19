import { Module } from '@nestjs/common';

import { AuditWriterModule } from '../audit/audit-writer.module';
import { DatabaseModule } from '../database/database.module';
import { PlatformRulesController } from './platform-rules.controller';
import { PlatformRulesService } from './platform-rules.service';
import { RulesLayersCache } from './rules-layers.cache';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

// DatabaseModule es obligatorio: RulesService inyecta TenantContextService y
// PlatformRulesService el DataSource (el nivel plataforma no tiene tenant).
@Module({
  imports: [DatabaseModule, AuditWriterModule],
  controllers: [RulesController, PlatformRulesController],
  providers: [RulesLayersCache, RulesService, PlatformRulesService],
  exports: [RulesService],
})
export class RulesModule {}
