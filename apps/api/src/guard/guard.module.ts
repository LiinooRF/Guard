import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EscalationModule } from '../escalation/escalation.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { GuardController } from './guard.controller';
import { DeviceSignatureService } from './device-signature.service';
import { GuardService } from './guard.service';

// Se exporta el servicio para que la sincronizacion en lote (#14) reuse
// registerScan/reportEvent en vez de reimplementar el flujo de escaneo.
@Module({
  imports: [DatabaseModule, MailModule, RulesModule, EscalationModule],
  controllers: [GuardController],
  providers: [GuardService, DeviceSignatureService],
  exports: [GuardService],
})
export class GuardModule {}
