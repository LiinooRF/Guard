import { BullModule } from '@nestjs/bullmq';
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
import {
  BARRIDO_VENCIDAS_QUEUE_NAME,
  BarridoVencidasService,
} from './rondas-vencidas.barrido';
import { BarridoVencidasProcessor } from './rondas-vencidas.barrido.processor';

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
    // El barrido de rondas abandonadas: sin el, una ronda que NADIE toca se
    // queda `en_curso` para siempre y las alertas de escalamiento que filtran
    // por 'vencida' no disparan jamas. El vencimiento perezoso solo detecta al
    // guardia que vuelve; el que no vuelve es justo el caso que importa.
    BullModule.registerQueue({ name: BARRIDO_VENCIDAS_QUEUE_NAME }),
  ],
  controllers: [GuardController],
  providers: [
    GuardService,
    DeviceSignatureService,
    BarridoVencidasService,
    BarridoVencidasProcessor,
  ],
  exports: [GuardService],
})
export class GuardModule {}
