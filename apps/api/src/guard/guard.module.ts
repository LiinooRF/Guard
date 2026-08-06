import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EscalationModule } from '../escalation/escalation.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { GeoModule } from '../geo/geo.module';
import { EnvioInformeModule } from '../reports/envio-informe.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { GuardController } from './guard.controller';
import { DeviceSignatureService } from './device-signature.service';
import { GuardService } from './guard.service';

// Se exporta el servicio para que la sincronizacion en lote (#14) reuse
// registerScan/reportEvent en vez de reimplementar el flujo de escaneo.
//
// EvidenceModule entra para que el escaneo y la pantalla del turno resuelvan la
// foto obligatoria del punto con isPhotoRequired() de @voxia/shared, que es lo
// que EvidenceService ya sabia hacer y nadie llamaba. No hay ciclo: evidence
// solo depende de database y rules.
@Module({
  imports: [
    DatabaseModule,
    MailModule,
    RulesModule,
    EscalationModule,
    GeoModule,
    EnvioInformeModule,
    EvidenceModule,
  ],
  controllers: [GuardController],
  providers: [GuardService, DeviceSignatureService],
  exports: [GuardService],
})
export class GuardModule {}
