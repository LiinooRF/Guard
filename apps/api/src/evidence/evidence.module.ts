import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { EventPhotosService } from './event-photos.service';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { PhotoServingController } from './photo-serving.controller';
import { PhotoServingService } from './photo-serving.service';

// DatabaseModule es obligatorio: ambos servicios inyectan TenantContextService.
// Se exporta EvidenceService para que el flujo de escaneo consulte requiresPhoto()
// y EventPhotosService para el anexo fotografico del informe.
@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [EvidenceController, PhotoServingController],
  providers: [EvidenceService, EventPhotosService, PhotoServingService],
  exports: [EvidenceService, EventPhotosService, PhotoServingService],
})
export class EvidenceModule {}
