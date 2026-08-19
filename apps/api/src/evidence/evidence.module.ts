import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ReportsModule } from '../reports/reports.module';
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
  // ReportsModule solo por PatrolReportService.invalidarCache(): la foto que
  // llega tarde a una ronda cerrada tiene que tumbar el PDF cacheado (#320).
  imports: [DatabaseModule, RulesModule, ReportsModule],
  controllers: [EvidenceController, PhotoServingController],
  providers: [EvidenceService, EventPhotosService, PhotoServingService],
  exports: [EvidenceService, EventPhotosService, PhotoServingService],
})
export class EvidenceModule {}
