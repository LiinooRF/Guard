import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';

// DatabaseModule es obligatorio: EvidenceService inyecta TenantContextService.
// Se exporta el servicio para que el flujo de escaneo consulte requiresPhoto().
@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
