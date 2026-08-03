import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

// DatabaseModule es obligatorio: RulesService inyecta TenantContextService.
@Module({
  imports: [DatabaseModule],
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
